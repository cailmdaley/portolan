/**
 * KanbanModal — global view of constitution-tagged fibers grouped by lifecycle.
 *
 * Five columns in a horizontal scroll carousel (Drafts → Open → Awaiting → Tempered →
 * Composted). Three columns are visible at a time; scroll-snap lands on column starts.
 * Scrolling loops: past Composted wraps to Drafts, and before Drafts wraps to Composted.
 *
 * The loop uses a 9-column DOM track with start/end clones so the reset is seamless
 * (two of three visible columns survive the wrap, masking the instantaneous jump).
 *
 * Awaiting-review is visually emphasized — that's the human-action queue.
 * Tempered and Composted are scroll-reachable edge cases.
 *
 * Interaction: drag a card to any column (HTML5 DnD). Both surfaces POST to
 * /kanban/transition with {fiberId, target}. Click a card body to open in vellum.
 */

/** Column identifier — also doubles as the API target. */
type ColumnKind = 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered' | 'composted'

const COLUMN_TITLES: Record<ColumnKind, string> = {
  drafts: 'Drafts',
  inFlight: 'Open',
  awaitingReview: 'Awaiting review',
  tempered: 'Tempered',
  composted: 'Composted',
}

const COLUMN_BLURBS: Record<ColumnKind, string> = {
  drafts: 'Brainstorming. Tagged constitution+draft. Refine until ready, then promote.',
  inFlight: 'Constitution-tagged, not closed. Workers running show ▸; otherwise queued.',
  awaitingReview: 'Your move — agent flipped the fiber to closed.',
  tempered: 'Recent — accepted by Cail.',
  composted: 'Discarded — mooted, superseded, or did not survive review.',
}

// (Action-button helpers removed — drag is the only transition surface for
// now. The DnD drop handler reads `target` from the column the card lands
// on, no per-card mapping needed. Re-introduce TRANSITIONS_FROM if a
// keyboard / context-menu path returns later.)

interface KanbanCard {
  id: string
  name: string
  path: string
  /**
   * Origin that contributed this fiber — `local` for filesystem-walk sources,
   * `remote-<hostname>` for fibers sourced from an agent's fiber-tree
   * snapshot. Drives the "waiting on `<hostname>`" stale badge and the
   * drag-disable when the originating agent is disconnected (Stage 3b).
   */
  originId: string
  status: string
  outcome?: string
  tags?: string[]
  createdAt: string
  closedAt?: string
  tempered?: boolean
  dependsOn?: string[]
  dependsOnSatisfied: boolean
  /** When set, a Shuttle worker is currently running for this fiber. */
  runningWorker?: string
  /**
   * Pinned local city whose `.felt/` physically owns this fiber, when the
   * server can resolve it (loom-deduped to the deepest project root).
   * Pairs with `projectSlug` to drive the click-to-open flow: the frontend
   * pivots vellum to this city and navigates to `projectSlug` instead of
   * the loom-relative `id`. Undefined for remote-origin fibers and for
   * paths that don't fall under any pinned city.
   */
  cityId?: string
  /**
   * Slug relative to the owning city's `.felt/` root. The vellum collection's
   * astra graph is keyed by these project-relative slugs, so this is what
   * the frontend hands to `navigate()` once it's pivoted to `cityId`.
   */
  projectSlug?: string
}

/**
 * Per-origin freshness signal returned in `/kanban` responses. Stage 3b
 * surfaces this on the cards: stale-origin cards show a "waiting on
 * `<hostname>`" badge and refuse drag, since the remote agent is
 * disconnected and any mutation would have nowhere to land.
 *
 * Local origin is always 'fresh'. Remote origins are 'fresh' while the
 * agent is connected and 'stale' from disconnect through reconnect.
 */
interface KanbanOriginStaleness {
  status: 'fresh' | 'stale'
  /** Hostname for human-readable badging (e.g. "waiting on cineca"). */
  hostname?: string
  /** ISO timestamp; only set when status === 'stale'. */
  staleSince?: string
}

interface KanbanResponse {
  feltHost: string
  columns: {
    drafts: KanbanCard[]
    inFlight: KanbanCard[]
    awaitingReview: KanbanCard[]
    tempered: KanbanCard[]
    composted: KanbanCard[]
  }
  totals: { drafts: number; inFlight: number; awaitingReview: number; tempered: number; composted: number }
  temperedTotal: number
  /**
   * Per-origin freshness, keyed by `originId`. Always includes `local` and
   * an entry for every remote origin with a snapshot in the store. The
   * frontend reads this to render the "waiting on `<hostname>`" stale
   * badge and to disable drag for stale-origin cards.
   */
  staleness: Record<string, KanbanOriginStaleness>
  generatedAt: number
}

interface KanbanModalOptions {
  /** Called when the user activates a card — host opens the fiber's md in vellum. */
  onOpenFiber: (card: KanbanCard) => void
  /**
   * Called when the user clicks a card's running-worker indicator. The host
   * resolves the tmux session name to a portolan session id and focuses that
   * kitty tab. No-op when the running tmux session isn't tracked by portolan.
   */
  onOpenWorker?: (tmuxSessionName: string) => void
  /**
   * Called when the user clicks the header's `+` stash button. The host
   * (KanbanHost in src/vellum/mount.tsx) opens the StashForm modal. Mirrors
   * the `n` hotkey path so keyboard and mouse converge on the same affordance.
   * Omit to hide the button (e.g. read-only contexts).
   */
  onStashClick?: () => void
  /** Override fetch base. Defaults to `http://${hostname}:4004`. */
  apiBase?: string
}

/**
 * When set, scope the kanban to a single city via `?cityId=` query param.
 * Default null = loom-wide (the original v0 behaviour). Stage 1 of the
 * vellum-kanban constitution: local-origin cities only; remote-origin
 * city scoping unlocks in Stage 3.
 */
interface KanbanCityScope {
  cityId: string
  cityName: string
}

export class KanbanModal {
  private readonly onOpenFiber: (card: KanbanCard) => void
  private readonly onOpenWorker?: (tmuxSessionName: string) => void
  private readonly onStashClick?: () => void
  private readonly apiBase: string

  private container: HTMLDivElement | null = null
  private body: HTMLDivElement | null = null
  private statusEl: HTMLDivElement | null = null
  private subtitleEl: HTMLDivElement | null = null
  private liveEl: HTMLDivElement | null = null
  private bannerEl: HTMLDivElement | null = null
  private inflightFetchToken = 0
  private dragSourceId: string | null = null
  private bannerTimer: number | null = null
  /** Null = global (default). Set by mount(...{cityScope}); cleared by
   *  unmount(). */
  private cityScope: KanbanCityScope | null = null

  constructor(options: KanbanModalOptions) {
    this.onOpenFiber = options.onOpenFiber
    this.onOpenWorker = options.onOpenWorker
    this.onStashClick = options.onStashClick
    this.apiBase = options.apiBase ?? `http://${window.location.hostname}:4004`
    this.injectStyles()
  }

  /**
   * Mount the kanban inside `host`. The host owns layout (size, position,
   * border), scrim, Escape ordering, and lockBackground — vellum's workspace
   * slot supplies the host div and the modal chrome around it; the kanban
   * only stretches to fill it.
   *
   * Re-mount with a different `cityScope` is supported in place: scope swap
   * updates the chrome and refetches without rebuilding the DOM. Re-mount
   * onto a different host element isn't supported (call `unmount()` first).
   *
   * @param host  container element; the kanban appends a single child div.
   * @param opts.cityScope  optional per-city scope; null = global aggregation.
   */
  mount(
    host: HTMLElement,
    opts: { cityScope?: KanbanCityScope | null } = {},
  ): void {
    if (this.container !== null) {
      // Already mounted: scope swap is the only meaningful re-call. Update
      // and refetch in place rather than rebuilding DOM from scratch.
      this.cityScope = opts.cityScope ?? null
      this.updateScopeChrome()
      void this.fetchAndRender()
      return
    }
    this.cityScope = opts.cityScope ?? null
    this.assembleChrome()
    host.append(this.container!)
    void this.fetchAndRender()
  }

  /**
   * Tear down a mounted kanban. Safe to call when not mounted — no-op.
   * The host is responsible for removing the host div itself; we only own
   * the kanban's container (already a child of host).
   */
  unmount(): void {
    if (this.container === null) return
    this.container.remove()
    this.teardownState()
  }

  // ---------------------------------------------------------------------------

  /**
   * Build the kanban DOM into `this.container`. Vellum's outer modal owns
   * close (via its own close button) — the kanban only renders the column
   * grid, header, banner, and live region.
   */
  private assembleChrome(): void {
    this.container = document.createElement('div')
    this.container.className = 'kbn-modal'
    this.container.setAttribute('role', 'dialog')
    this.container.setAttribute('aria-modal', 'true')
    this.container.setAttribute('aria-label', 'Kanban — constitution fibers')

    const header = document.createElement('div')
    header.className = 'kbn-header'

    const title = document.createElement('div')
    title.className = 'kbn-title'
    title.textContent = 'Kanban'
    this.subtitleEl = document.createElement('div')
    this.subtitleEl.className = 'kbn-subtitle'
    this.subtitleEl.textContent = this.subtitleText()

    const titleWrap = document.createElement('div')
    titleWrap.className = 'kbn-title-wrap'
    titleWrap.append(title, this.subtitleEl)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'kbn-status'
    this.statusEl.textContent = 'Loading…'

    header.append(titleWrap, this.statusEl)

    // Stash button: gold `+` at the header's right edge, mirroring the `n`
    // hotkey owned by KanbanHost. We bind via callback so the React host
    // keeps ownership of the StashForm modal state — KanbanModal just emits
    // the click. Hidden when no callback wired (read-only contexts).
    if (this.onStashClick !== undefined) {
      const stashBtn = document.createElement('button')
      stashBtn.type = 'button'
      stashBtn.className = 'kbn-stash-btn'
      stashBtn.setAttribute('aria-label', 'Stash a new fiber (n)')
      stashBtn.title = 'Stash a new fiber (n)'
      stashBtn.textContent = '+'
      stashBtn.addEventListener('click', () => this.onStashClick?.())
      header.append(stashBtn)
    }

    this.body = document.createElement('div')
    this.body.className = 'kbn-body kbn-carousel'
    this.body.addEventListener('scrollend', () => this.handleCarouselScroll())
    let scrollTimer: number | null = null
    this.body.addEventListener('scroll', () => {
      if (scrollTimer) window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => this.handleCarouselScroll(), 150)
    })

    // aria-live region for transition announcements ("Moved 'X' to Tempered.")
    // — invisible but read by screen readers and observable in the a11y tree.
    this.liveEl = document.createElement('div')
    this.liveEl.className = 'kbn-live'
    this.liveEl.setAttribute('role', 'status')
    this.liveEl.setAttribute('aria-live', 'polite')

    // Transient error/info banner for transitions that fail.
    this.bannerEl = document.createElement('div')
    this.bannerEl.className = 'kbn-banner'
    this.bannerEl.setAttribute('role', 'alert')
    this.bannerEl.style.display = 'none'

    this.container.append(header, this.bannerEl, this.body, this.liveEl)
  }

  /** Reset all field state to "not mounted." DOM removal is `unmount()`'s
   *  responsibility; this only clears references. */
  private teardownState(): void {
    this.container = null
    this.body = null
    this.statusEl = null
    this.subtitleEl = null
    this.liveEl = null
    this.bannerEl = null
    this.dragSourceId = null
    // Reset scope on every teardown so the next mount lands at default
    // global scope; a follow-on `mount(...{cityScope})` with a scope
    // re-sets before assemble.
    this.cityScope = null
    if (this.bannerTimer !== null) {
      window.clearTimeout(this.bannerTimer)
      this.bannerTimer = null
    }
  }

  // ── Transitions ─────────────────────────────────────────────────────────────

  /**
   * POST a transition to /kanban/transition. Refetches the kanban on success;
   * shows the banner on failure. Optimism is left to the caller (the click
   * handler removes the card from the source DOM list before awaiting).
   */
  private async transition(card: KanbanCard, target: ColumnKind): Promise<void> {
    const fromKind = columnOf(card)
    if (fromKind === target) return

    try {
      const res = await fetch(this.transitionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, target }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `${res.status}` })) as { error?: string }
        throw new Error(errBody.error || `Transition failed: ${res.status}`)
      }
      this.announce(`Moved “${card.name}” to ${COLUMN_TITLES[target]}.`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't move “${card.name}” to ${COLUMN_TITLES[target]}: ${msg}`, 'error')
      this.announce(`Move failed: ${msg}`)
    }
    // Always refetch — server is the source of truth.
    await this.fetchAndRender()
  }

  private announce(msg: string): void {
    if (!this.liveEl) return
    // Clear → set forces re-announcement on identical text.
    this.liveEl.textContent = ''
    window.setTimeout(() => {
      if (this.liveEl) this.liveEl.textContent = msg
    }, 50)
  }

  private showBanner(text: string, kind: 'error' | 'info' = 'info'): void {
    if (!this.bannerEl) return
    this.bannerEl.textContent = text
    this.bannerEl.style.display = ''
    this.bannerEl.classList.toggle('kbn-banner-error', kind === 'error')
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => {
      if (this.bannerEl) this.bannerEl.style.display = 'none'
      this.bannerTimer = null
    }, 5000)
  }

  private async fetchAndRender(): Promise<void> {
    const token = ++this.inflightFetchToken
    if (this.statusEl) this.statusEl.textContent = 'Loading…'
    try {
      const res = await fetch(this.kanbanUrl())
      if (token !== this.inflightFetchToken) return
      if (!res.ok) {
        this.renderError(`Server returned ${res.status}`)
        return
      }
      const data = (await res.json()) as KanbanResponse
      if (token !== this.inflightFetchToken) return
      this.lastResponse = data
      this.render(data)
    } catch (err: unknown) {
      if (token !== this.inflightFetchToken) return
      const msg = (err as { message?: string })?.message ?? String(err)
      this.renderError(msg)
    }
  }

  private renderError(msg: string): void {
    if (!this.body || !this.statusEl) return
    this.statusEl.textContent = ''
    this.body.innerHTML = ''
    const errEl = document.createElement('div')
    errEl.className = 'kbn-error'
    errEl.textContent = `Failed to load kanban: ${msg}`
    this.body.append(errEl)
  }

  private render(data: KanbanResponse): void {
    if (!this.body || !this.statusEl) return

    const { columns, totals, temperedTotal, staleness } = data
    this.statusEl.textContent =
      `${totals.drafts} drafts · ${totals.inFlight} open · ` +
      `${totals.awaitingReview} awaiting review · ${totals.tempered}/${temperedTotal} tempered` +
      (totals.composted > 0 ? ` · ${totals.composted} composted` : '')

    this.body.innerHTML = ''
    this.body.classList.remove('kbn-body-zoomed')

    // Build the 5-column carousel with lead/trail clones for seamless looping.
    // 11 total columns: 3 lead clones + 5 real + 3 trail clones.
    // Scroll-snap lands on column starts. Initial view: Drafts | InFlight | Awaiting.
    const colOrder: ColumnKind[] = ['drafts', 'inFlight', 'awaitingReview', 'tempered', 'composted']
    const makeCol = (kind: ColumnKind) =>
      this.renderColumn(kind, columns[kind], staleness, kind === 'tempered' ? temperedTotal : undefined)

    const real = colOrder.map(makeCol)
    const lead = colOrder.slice(2).map(makeCol)   // awaitingReview, tempered, composted
    const trail = colOrder.slice(0, 3).map(makeCol) // drafts, inFlight, awaitingReview

    for (const col of [...lead, ...real, ...trail]) {
      col.classList.add('kbn-carousel-col')
      this.body.append(col)
    }

    // Snap to the real section start (index 3 = Drafts) after layout.
    requestAnimationFrame(() => {
      if (!this.body) return
      const children = this.body.children
      const realStart = children[3] as HTMLElement | undefined
      if (realStart) this.body.scrollLeft = realStart.offsetLeft
    })

    this.lastResponse = data
  }

  /**
   * Loop detection for the horizontal carousel. Called on `scrollend` (and
   * debounced `scroll` fallback). If the snap landed in a clone zone, jump
   * silently to the equivalent real position so the loop is seamless.
   */
  private handleCarouselScroll(): void {
    if (!this.body) return
    if (this.body.classList.contains('kbn-body-zoomed')) return

    const children = Array.from(this.body.children) as HTMLElement[]
    if (children.length < 11) return

    let pos = 0
    let bestDist = Infinity
    for (let i = 0; i < children.length; i++) {
      const dist = Math.abs(children[i].offsetLeft - this.body.scrollLeft)
      if (dist < bestDist) {
        bestDist = dist
        pos = i
      }
    }

    if (pos < 3) {
      const target = children[pos + 5]
      if (target) this.body.scrollLeft = target.offsetLeft
    } else if (pos > 7) {
      const target = children[pos - 5]
      if (target) this.body.scrollLeft = target.offsetLeft
    }
  }

  /**
   * Render one column. Supports drag-and-drop as a drop target with visual
   * feedback. The list element carries role="list" and each card carries
   * role="listitem" so the a11y tree shows a structured "X cards in Y column"
   * shape that agent-browser's snapshot can navigate cleanly.
   *
   * `staleness` is threaded through from the response so each card can look
   * up its origin's freshness for the Stage 3b drag-disable + waiting badge.
   */
  private renderColumn(
    kind: ColumnKind,
    cards: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
    temperedTotal?: number,
  ): HTMLElement {
    const title = COLUMN_TITLES[kind]
    const col = document.createElement('section')
    col.className = `kbn-col kbn-col-${kind}`
    col.setAttribute('role', 'region')
    col.setAttribute('aria-label', `${title} (${cards.length})`)
    col.dataset.column = kind

    const head = document.createElement('div')
    head.className = 'kbn-col-head'
    head.setAttribute('role', 'button')
    head.setAttribute('tabindex', '0')
    head.setAttribute('aria-label', `Zoom ${title} column`)
    const headTitle = document.createElement('h2')
    headTitle.className = 'kbn-col-title'
    headTitle.textContent = title
    const headCount = document.createElement('span')
    headCount.className = 'kbn-col-count'
    headCount.textContent = kind === 'tempered' && temperedTotal !== undefined
      ? `${cards.length}/${temperedTotal}`
      : String(cards.length)
    head.append(headTitle, headCount)

    const toggleZoom = (): void => this.toggleColumnZoom(col)
    head.addEventListener('click', toggleZoom)
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggleZoom()
      }
    })

    const blurbEl = document.createElement('div')
    blurbEl.className = 'kbn-col-blurb'
    blurbEl.textContent = COLUMN_BLURBS[kind]

    const list = document.createElement('div')
    list.className = 'kbn-col-list'
    list.setAttribute('role', 'list')

    // Drop zone — accept drag events on the column body and the list.
    const onDragOver = (e: DragEvent): void => {
      if (!this.dragSourceId) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      col.classList.add('kbn-col-drop')
    }
    const onDragLeave = (e: DragEvent): void => {
      // Only remove if we're really leaving the column (not just moving between children).
      if (e.relatedTarget && col.contains(e.relatedTarget as Node)) return
      col.classList.remove('kbn-col-drop')
    }
    const onDrop = (e: DragEvent): void => {
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.dragSourceId
      col.classList.remove('kbn-col-drop')
      this.dragSourceId = null
      if (!fiberId) return
      e.preventDefault()
      const card = findCardById(this.lastResponse, fiberId)
      if (!card) return
      void this.transition(card, kind)
    }
    col.addEventListener('dragover', onDragOver)
    col.addEventListener('dragleave', onDragLeave)
    col.addEventListener('drop', onDrop)

    if (cards.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-empty'
      empty.setAttribute('role', 'listitem')
      empty.textContent = '— nothing here —'
      list.append(empty)
    } else {
      for (const card of cards) {
        list.append(this.renderCard(card, kind, staleness[card.originId]))
      }
    }

    col.append(head, blurbEl, list)
    return col
  }

  /**
   * Render one card. Two interaction surfaces converge here:
   *
   *  - Drag (mouse): the outer .kbn-card is `draggable=true` and emits the
   *    fiber id as `text/x-fiber-id`. Drop handlers live on the columns.
   *
   *  - Action buttons (keyboard / a11y tree): the footer carries explicit
   *    `Move to <Column>` buttons for every column the card isn't currently
   *    in. These are visible (not hover-only) and labeled with the card name
   *    so screen readers and agent-browser snapshots can drive transitions
   *    deterministically: `find role button --name "Approve 'Constitution: Shuttle'"`
   *    is a stable handle.
   *
   * Click on the card body (not on a button or the drag handle) opens the
   * fiber's md in vellum.
   *
   * `originStaleness` is the entry from the response's `staleness` map for
   * this card's origin. When undefined or status==='fresh', the card behaves
   * normally. When status==='stale', we show a "waiting on `<hostname>`"
   * badge, dim the card, and disable drag — the originating agent is
   * disconnected and any mutation would have nowhere to land.
   */
  private renderCard(
    card: KanbanCard,
    kind: ColumnKind,
    originStaleness?: KanbanOriginStaleness,
  ): HTMLElement {
    const isStale = originStaleness?.status === 'stale'

    const el = document.createElement('div')
    el.className = `kbn-card kbn-card-${kind}${isStale ? ' kbn-card--stale' : ''}`
    el.setAttribute('role', 'listitem')
    const ariaSuffix = isStale
      ? ` — waiting on ${originStaleness.hostname ?? card.originId}, drag disabled`
      : ''
    el.setAttribute('aria-label', `${card.name} — ${COLUMN_TITLES[kind]}${ariaSuffix}`)
    el.draggable = !isStale
    el.dataset.fiberId = card.id

    if (!isStale) {
      el.addEventListener('dragstart', (e) => {
        this.dragSourceId = card.id
        el.classList.add('kbn-card-dragging')
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/x-fiber-id', card.id)
          e.dataTransfer.setData('text/plain', card.name)
        }
      })
      el.addEventListener('dragend', () => {
        el.classList.remove('kbn-card-dragging')
        this.dragSourceId = null
      })
    }

    // Header row: name + status pill (+ drag-handle hint)
    const headerRow = document.createElement('div')
    headerRow.className = 'kbn-card-header'

    const dragHandle = document.createElement('span')
    dragHandle.className = 'kbn-card-handle'
    dragHandle.setAttribute('aria-hidden', 'true')
    dragHandle.title = isStale ? 'Drag disabled — origin offline' : 'Drag to move'
    dragHandle.textContent = '⋮⋮'

    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'kbn-card-name'
    name.setAttribute('aria-label', `Open fiber ${card.name} in vellum`)
    name.textContent = card.name
    name.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onOpenFiber(card)
    })

    const pill = document.createElement('span')
    pill.className = `kbn-pill kbn-pill-${this.pillKind(card)}`
    pill.textContent = this.pillLabel(card)

    headerRow.append(dragHandle, name, pill)
    el.append(headerRow)

    // Fiber id (small, breadcrumb-ish)
    const idEl = document.createElement('div')
    idEl.className = 'kbn-card-id'
    idEl.textContent = card.id
    el.append(idEl)

    // Outcome (truncated; CSS line-clamp)
    if (card.outcome) {
      const outcome = document.createElement('div')
      outcome.className = 'kbn-card-outcome'
      outcome.textContent = card.outcome
      el.append(outcome)
    }

    // Tags + date row
    const meta = document.createElement('div')
    meta.className = 'kbn-card-meta'

    const tagWrap = document.createElement('div')
    tagWrap.className = 'kbn-card-tags'
    const visibleTags = (card.tags ?? []).filter(t => t !== 'constitution').slice(0, 4)
    for (const t of visibleTags) {
      const chip = document.createElement('span')
      chip.className = 'kbn-tag'
      chip.textContent = t
      tagWrap.append(chip)
    }

    const date = document.createElement('div')
    date.className = 'kbn-card-date'
    const stamp = card.closedAt || card.createdAt
    date.textContent = stamp ? formatRelative(stamp) : ''

    meta.append(tagWrap, date)
    el.append(meta)

    // Blocked indicator on in-flight cards with unsatisfied deps
    if (kind === 'inFlight' && !card.dependsOnSatisfied) {
      const block = document.createElement('div')
      block.className = 'kbn-card-blocked'
      block.textContent = `blocked on: ${(card.dependsOn ?? []).join(', ')}`
      el.append(block)
    }

    // Running-worker indicator on active cards. Clickable: focuses the
    // worker's tmux session in kitty so the operator can watch it live.
    if (card.runningWorker) {
      const tmuxName = card.runningWorker
      const w = document.createElement('button')
      w.type = 'button'
      w.className = 'kbn-card-worker'
      w.setAttribute('aria-label', `Open worker terminal: ${tmuxName}`)
      w.title = `Click to open ${tmuxName} in kitty`
      w.textContent = `▸ ${tmuxName}`
      w.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onOpenWorker?.(tmuxName)
      })
      el.append(w)
    }

    // Stale-origin badge: the originating agent is disconnected. The card
    // still reads (snapshot is preserved), but mutation has nowhere to land
    // until reconnect, so drag is disabled (above) and we show a clear
    // signal here. Hostname falls back to the bare originId if the server
    // didn't supply one.
    if (isStale) {
      const hostname = originStaleness.hostname ?? card.originId
      const waiting = document.createElement('div')
      waiting.className = 'kbn-card-waiting'
      waiting.setAttribute('role', 'status')
      waiting.title = originStaleness.staleSince
        ? `Disconnected since ${originStaleness.staleSince}`
        : 'Origin agent disconnected'
      waiting.textContent = `⌛ waiting on ${hostname}`
      el.append(waiting)
    }

    // Click outside any button → open in vellum (delegated catch-all).
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      this.onOpenFiber(card)
    })

    return el
  }

  /** Stash the latest response so drop handlers can resolve cards by id. */
  private lastResponse: KanbanResponse | null = null

  // ── URL + chrome helpers (city-scope aware) ────────────────────────────────

  /** GET endpoint for the kanban list, with `?cityId=` when scoped. */
  private kanbanUrl(): string {
    const base = `${this.apiBase}/kanban`
    if (!this.cityScope) return base
    return `${base}?cityId=${encodeURIComponent(this.cityScope.cityId)}`
  }

  /** POST endpoint for transitions, with `?cityId=` when scoped. */
  private transitionUrl(): string {
    const base = `${this.apiBase}/kanban/transition`
    if (!this.cityScope) return base
    return `${base}?cityId=${encodeURIComponent(this.cityScope.cityId)}`
  }

  /** Subtitle copy: scope-aware so the user can read what they're looking at. */
  private subtitleText(): string {
    if (!this.cityScope) return 'constitution-tagged fibers'
    return `constitution-tagged fibers · ${this.cityScope.cityName}`
  }

  /** Update DOM that depends on `cityScope` after a scope swap. */
  private updateScopeChrome(): void {
    if (this.subtitleEl) this.subtitleEl.textContent = this.subtitleText()
  }

  /**
   * Toggle full-body zoom on a single column. The modal body keeps the
   * surrounding grid; CSS hides the non-zoomed columns and lets the zoomed
   * one fill the row. A second click on the same header un-zooms.
   */
  private toggleColumnZoom(col: HTMLElement): void {
    if (!this.body) return
    const wasZoomed = col.classList.contains('kbn-col-zoomed')
    // Clear any prior zoom (only one column at a time).
    for (const c of this.body.querySelectorAll<HTMLElement>('.kbn-col-zoomed')) {
      c.classList.remove('kbn-col-zoomed')
    }
    if (!wasZoomed) col.classList.add('kbn-col-zoomed')
    this.body.classList.toggle('kbn-body-zoomed', !wasZoomed)
  }

  private pillKind(card: KanbanCard): 'open' | 'active' | 'closed' | 'tempered' | 'composted' {
    if (card.tempered === true) return 'tempered'
    if (card.tempered === false) return 'composted'
    if (card.status === 'closed') return 'closed'
    if (card.status === 'active') return 'active'
    return 'open'
  }

  private pillLabel(card: KanbanCard): string {
    if (card.tempered === true) return 'tempered'
    if (card.tempered === false) return 'composted'
    return card.status || 'open'
  }

  // ---------------------------------------------------------------------------

  private injectStyles(): void {
    if (document.getElementById('kbn-styles')) return
    const style = document.createElement('style')
    style.id = 'kbn-styles'
    style.textContent = `
      /* Fills the host element supplied by vellum's workspace slot
         (KanbanHost in src/vellum/mount.tsx). The host gives us a fixed-
         viewport positioning context; the kanban stretches to inset:0
         inside it. No border or shadow — vellum's outer modal already
         provides the chrome boundary, and a nested border reads as
         tile-in-tile.

         Header padding-left clears 44px for vellum's modal close button
         (24px wide at left:8px — see vellum/mount.tsx:openVellumWorkspaceModal). */
      .kbn-modal {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        background: #EDE8E0;
        display: flex; flex-direction: column;
        font-family: var(--font-main, 'EB Garamond', serif);
        color: #2E2A26;
        overflow: hidden;
      }
      /* Header band aligns with vellum's thumb-index: bottom edge meets
         --thumb-index-bottom (so the kanban grid below starts on the same
         horizontal line as the thumb-index ends), right edge clears
         --canvas-width (so the band's content doesn't sit under the
         thumb-index in the top-right corner). The thumb-index visually
         extends the band's right portion — same chrome layer, two pieces.
         The min-height falls back to the natural header height when the
         var isn't published yet (initial paint, before FloatingIsland's
         ResizeObserver fires). */
      .kbn-header {
        display: flex; align-items: center; gap: 16px;
        padding: 14px 20px 14px 44px;
        padding-right: calc(20px + var(--canvas-width, 360px));
        min-height: var(--thumb-index-bottom, auto);
        border-bottom: 1px solid rgba(46, 42, 38, 0.12);
        background: #E5DED2;
        flex-shrink: 0;
        box-sizing: border-box;
      }
      .kbn-title-wrap {
        display: flex; align-items: baseline; gap: 8px;
      }
      .kbn-title {
        font-size: 22px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .kbn-subtitle {
        font-style: italic;
        font-size: 14px;
        color: #7A7068;
      }
      .kbn-status {
        flex: 1;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 11px;
        color: #7A7068;
        letter-spacing: 0.02em;
        text-align: center;
      }
      /* Stash trigger: gold + at the header's right edge. Pairs with the
         "n" hotkey owned by KanbanHost; semantically belongs in the kanban's
         own chrome rather than floated over from the React host (the floating
         version was getting hidden behind FloatingIsland and offset wrong by
         vellum's chrome assumptions). */
      .kbn-stash-btn {
        flex-shrink: 0;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: #9A7B35;
        color: #FFFFFF;
        border: 1px solid #7A6028;
        box-shadow: 0 2px 4px rgba(46, 42, 38, 0.18);
        font-size: 18px;
        line-height: 1;
        font-family: var(--font-main, 'EB Garamond', serif);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease-out, transform 120ms ease-out;
      }
      .kbn-stash-btn:hover,
      .kbn-stash-btn:focus-visible {
        background: #B08D3D;
        transform: scale(1.06);
        outline: none;
      }
      .kbn-stash-btn:focus-visible {
        box-shadow: 0 0 0 3px rgba(154, 123, 53, 0.36);
      }
      /* aria-live region — invisible but observable in the a11y tree. */
      .kbn-live {
        position: absolute;
        width: 1px; height: 1px;
        margin: -1px; padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        border: 0;
      }
      .kbn-banner {
        margin: 0 20px;
        padding: 8px 12px;
        background: rgba(154, 123, 53, 0.12);
        border: 1px solid rgba(154, 123, 53, 0.4);
        color: #6B5520;
        font-size: 13px;
        border-radius: 2px;
        margin-top: 8px;
      }
      .kbn-banner-error {
        background: rgba(178, 78, 60, 0.12);
        border-color: rgba(178, 78, 60, 0.5);
        color: #8B3A28;
      }
      /* Carousel: horizontal scroll with snap-to-column. Five equal columns,
         three visible at a time (~33% each). Lead/trail clones sit offscreen
         so the loop resets are seamless. */
      .kbn-body {
        flex: 1;
        display: flex;
        gap: 10px;
        padding: 12px;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-behavior: smooth;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        min-height: 0;
      }
      .kbn-carousel-col {
        flex: 0 0 calc((100% - 20px) / 3); /* account for two 10px gaps per 3-col view */
        scroll-snap-align: start;
        min-width: 0;
        max-width: calc((100% - 20px) / 3);
      }
      /* When zoomed, the carousel scroll is gated and the body becomes a
         normal flex grid. */
      .kbn-body.kbn-body-zoomed {
        overflow-x: hidden;
        scroll-snap-type: none;
      }
      .kbn-body.kbn-body-zoomed .kbn-carousel-col {
        flex: 0 0 auto;
        min-width: unset;
        max-width: none;
      }
      .kbn-body.kbn-body-zoomed .kbn-col:not(.kbn-col-zoomed) {
        display: none;
      }
      .kbn-body.kbn-body-zoomed .kbn-col-zoomed {
        width: 100%;
        flex: 1;
      }
      /* When zoomed, tile cards as a CSS grid filling the available width
         rather than stacking in a single column. The zoom's whole point is
         to reveal more of a column's contents at once; a single stack inside
         a full-width view leaves most of the screen empty. auto-fill +
         minmax keeps cards at a readable minimum and packs as many per row
         as the width allows. */
      .kbn-col-zoomed .kbn-col-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        align-content: start;
        gap: 12px;
      }
      .kbn-col-head {
        cursor: zoom-in;
      }
      .kbn-col-zoomed .kbn-col-head {
        cursor: zoom-out;
      }
      .kbn-col {
        display: flex; flex-direction: column;
        min-height: 0;
        background: #F4F0E8;
        border: 1px solid rgba(46, 42, 38, 0.10);
        border-radius: 3px;
        overflow: hidden;
        transition: background 150ms ease, border-color 150ms ease;
      }
      .kbn-col-awaitingReview {
        border-color: rgba(154, 123, 53, 0.55);
        box-shadow: inset 0 0 0 1px rgba(154, 123, 53, 0.18);
      }
      .kbn-col-drafts {
        background: #F0EDE6;
        border-style: dashed;
        opacity: 0.92;
      }
      .kbn-col-drafts .kbn-col-title { color: #7A7068; font-style: italic; }
      /* Composted column: desaturated Earth tone, visually sits at the
         boundary between Tempered and "the unbuilt" (Drafts on wrap). */
      .kbn-col-composted {
        background: #EAE6DE;
        border-color: rgba(122, 112, 104, 0.35);
        box-shadow: inset 0 0 0 1px rgba(122, 112, 104, 0.12);
      }
      .kbn-col-composted .kbn-col-title { color: #7A7068; font-style: italic; }
      .kbn-col-tempered {
        background: #EFEBE3;
      }
      /* Active drop target while a drag is in progress. */
      .kbn-col-drop {
        background: rgba(154, 123, 53, 0.10);
        border-color: rgba(154, 123, 53, 0.55);
        box-shadow: inset 0 0 0 2px rgba(154, 123, 53, 0.45);
      }
      .kbn-col-head {
        display: flex; align-items: baseline; justify-content: space-between;
        padding: 10px 14px 4px;
      }
      .kbn-col-title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .kbn-col-awaiting .kbn-col-title { color: #9A7B35; }
      .kbn-col-tempered .kbn-col-title { color: #5A7B7B; }
      .kbn-col-count {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 12px;
        color: #7A7068;
      }
      .kbn-col-blurb {
        padding: 0 14px 8px;
        font-size: 12px;
        font-style: italic;
        color: #7A7068;
        border-bottom: 1px solid rgba(46, 42, 38, 0.08);
      }
      .kbn-col-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex; flex-direction: column;
        gap: 8px;
      }
      .kbn-empty {
        text-align: center;
        color: #B8AC9E;
        font-style: italic;
        padding: 24px 8px;
        font-size: 13px;
      }
      .kbn-card {
        background: #FBF7F0;
        border: 1px solid rgba(46, 42, 38, 0.12);
        border-radius: 3px;
        padding: 10px 12px;
        text-align: left;
        cursor: grab;
        font-family: inherit;
        color: inherit;
        display: flex; flex-direction: column;
        gap: 6px;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, opacity 120ms ease;
      }
      .kbn-card:hover {
        background: #FFFCF6;
        border-color: rgba(46, 42, 38, 0.22);
        transform: translateY(-1px);
      }
      .kbn-card:active { cursor: grabbing; }
      .kbn-card-dragging {
        opacity: 0.45;
        transform: scale(0.98);
        cursor: grabbing;
      }
      .kbn-card-awaitingReview {
        border-color: rgba(154, 123, 53, 0.45);
      }
      .kbn-card-composted {
        padding: 6px 10px;
        gap: 4px;
        background: #F2EEE6;
        border-style: dashed;
      }
      .kbn-card-composted .kbn-card-name {
        font-size: 13px;
        font-weight: 500;
      }
      .kbn-card-composted .kbn-card-outcome {
        font-size: 11.5px;
        -webkit-line-clamp: 2;
        color: #6A645E;
      }
      /* Tempered cards are smaller — they're for the record, not the focus. */
      .kbn-card-tempered {
        padding: 6px 10px;
        gap: 4px;
        background: #F7F3EA;
      }
      .kbn-card-header {
        display: flex; align-items: flex-start; gap: 6px;
      }
      .kbn-card-handle {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 11px;
        color: #B8AC9E;
        line-height: 1.3;
        letter-spacing: -1px;
        user-select: none;
        cursor: grab;
        flex-shrink: 0;
        padding: 1px 0;
      }
      .kbn-card:active .kbn-card-handle { cursor: grabbing; }
      .kbn-card-name {
        flex: 1;
        font-size: 14.5px;
        font-weight: 600;
        line-height: 1.25;
        background: transparent;
        border: none;
        padding: 0;
        margin: 0;
        text-align: left;
        cursor: pointer;
        color: inherit;
        font-family: inherit;
      }
      .kbn-card-tempered .kbn-card-name {
        font-size: 13px;
        font-weight: 500;
      }
      .kbn-card-name:hover { text-decoration: underline; }
      .kbn-card-name:focus { outline: none; }
      .kbn-card-name:focus-visible {
        outline: 1px dashed #7A7068;
        outline-offset: 2px;
        border-radius: 1px;
      }
      .kbn-pill {
        display: inline-block;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 9.5px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 6px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .kbn-pill-open {
        background: rgba(154, 123, 53, 0.12);
        color: #9A7B35;
        border: 1px solid rgba(154, 123, 53, 0.3);
      }
      .kbn-pill-active {
        background: rgba(154, 123, 53, 0.25);
        color: #6B5520;
        border: 1px solid rgba(154, 123, 53, 0.45);
      }
      .kbn-pill-closed {
        background: rgba(122, 112, 104, 0.15);
        color: #7A7068;
        border: 1px solid rgba(122, 112, 104, 0.35);
      }
      .kbn-pill-tempered {
        background: rgba(90, 123, 123, 0.18);
        color: #4A6868;
        border: 1px solid rgba(90, 123, 123, 0.4);
      }
      .kbn-pill-composted {
        background: rgba(122, 112, 104, 0.12);
        color: #8A7E72;
        border: 1px solid rgba(122, 112, 104, 0.3);
      }
      .kbn-card-id {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        color: #B8AC9E;
        letter-spacing: 0.01em;
        word-break: break-all;
      }
      .kbn-card-outcome {
        font-size: 12.5px;
        line-height: 1.4;
        color: #4A4540;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .kbn-card-tempered .kbn-card-outcome {
        font-size: 11.5px;
        -webkit-line-clamp: 2;
        color: #6A645E;
      }
      .kbn-card-meta {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
        margin-top: 2px;
      }
      .kbn-card-actions {
        display: flex; gap: 6px; flex-wrap: wrap;
        padding-top: 6px;
        margin-top: 2px;
        border-top: 1px dashed rgba(46, 42, 38, 0.10);
      }
      .kbn-card-tempered .kbn-card-actions {
        padding-top: 4px;
        gap: 4px;
      }
      .kbn-action {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: rgba(46, 42, 38, 0.04);
        border: 1px solid rgba(46, 42, 38, 0.18);
        color: #4A4540;
        padding: 3px 8px;
        border-radius: 2px;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
      }
      .kbn-action:hover {
        background: rgba(46, 42, 38, 0.10);
        color: #2E2A26;
        border-color: rgba(46, 42, 38, 0.30);
      }
      .kbn-action:focus { outline: none; }
      .kbn-action:focus-visible {
        outline: 1px dashed #7A7068;
        outline-offset: 1px;
      }
      .kbn-action-tempered {
        background: rgba(90, 123, 123, 0.10);
        color: #4A6868;
        border-color: rgba(90, 123, 123, 0.40);
      }
      .kbn-action-tempered:hover {
        background: rgba(90, 123, 123, 0.20);
        color: #2E4848;
      }
      .kbn-action-awaitingReview {
        background: rgba(154, 123, 53, 0.10);
        color: #6B5520;
        border-color: rgba(154, 123, 53, 0.45);
      }
      .kbn-action-awaitingReview:hover {
        background: rgba(154, 123, 53, 0.20);
        color: #4A3810;
      }
      .kbn-action-inFlight {
        background: rgba(90, 123, 123, 0.08);
        color: #4A6868;
        border-color: rgba(90, 123, 123, 0.35);
      }
      .kbn-action-inFlight:hover {
        background: rgba(90, 123, 123, 0.18);
      }
      .kbn-action-drafts {
        background: rgba(122, 112, 104, 0.08);
        color: #7A7068;
        border-color: rgba(122, 112, 104, 0.30);
        font-style: italic;
      }
      .kbn-action-drafts:hover {
        background: rgba(122, 112, 104, 0.18);
        color: #2E2A26;
      }
      /* Subtler card style inside the drafts column. */
      .kbn-card-drafts {
        background: #F8F4EC;
        border-style: dashed;
      }
      .kbn-card-tags {
        display: flex; flex-wrap: wrap; gap: 4px;
      }
      .kbn-tag {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 9.5px;
        color: #7A7068;
        background: rgba(46, 42, 38, 0.05);
        padding: 1px 5px;
        border-radius: 2px;
      }
      .kbn-card-date {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        color: #B8AC9E;
        flex-shrink: 0;
      }
      .kbn-card-blocked {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        color: #9A7B35;
        background: rgba(154, 123, 53, 0.10);
        padding: 4px 6px;
        border-radius: 2px;
        margin-top: 2px;
      }
      .kbn-card-worker {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        color: #4A6868;
        background: rgba(90, 123, 123, 0.10);
        padding: 4px 6px;
        border-radius: 2px;
        margin-top: 2px;
        animation: kbn-pulse 2s ease-in-out infinite;
        /* Button reset */
        border: 1px solid transparent;
        text-align: left;
        font-weight: inherit;
        cursor: pointer;
        width: 100%;
        transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
      }
      .kbn-card-worker:hover {
        color: #2E4848;
        border-color: rgba(90, 123, 123, 0.55);
      }
      .kbn-card-worker:focus { outline: none; }
      .kbn-card-worker:focus-visible {
        outline: 1px dashed #4A6868;
        outline-offset: 2px;
      }
      @keyframes kbn-pulse {
        0%, 100% { background: rgba(90, 123, 123, 0.10); }
        50% { background: rgba(90, 123, 123, 0.22); }
      }
      /* Stale-origin card: the originating agent is disconnected. The
         snapshot is preserved (last-known-good) so the card still reads
         and clicks through to vellum, but drag is disabled because
         mutation has nowhere to land until reconnect. Visual signal
         is a desaturated dim plus a not-allowed cursor on the drag
         handle. */
      .kbn-card--stale {
        opacity: 0.62;
        background: #F4F0E8;
        border-style: dashed;
        cursor: default;
      }
      .kbn-card--stale:hover {
        background: #F4F0E8;
        border-color: rgba(46, 42, 38, 0.18);
        transform: none;
      }
      .kbn-card--stale:active { cursor: default; }
      .kbn-card--stale .kbn-card-handle {
        cursor: not-allowed;
        color: #C8BFB3;
      }
      .kbn-card--stale .kbn-card-name { color: #6A645E; }
      /* The waiting badge sits in the same band as kbn-card-blocked /
         kbn-card-worker — runtime-state info that depends on connection,
         not on fiber content. Cool grey-blue distinguishes "stale" from
         the warm gold of "blocked on dep" and the teal of "worker
         running." */
      .kbn-card-waiting {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        color: #5A6A78;
        background: rgba(90, 110, 130, 0.10);
        border: 1px dashed rgba(90, 110, 130, 0.35);
        padding: 4px 6px;
        border-radius: 2px;
        margin-top: 2px;
        letter-spacing: 0.02em;
      }
      .kbn-error {
        margin: 24px;
        padding: 16px;
        border: 1px solid rgba(154, 123, 53, 0.4);
        background: rgba(154, 123, 53, 0.08);
        color: #6B5520;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 13px;
      }

      @media (max-width: 1100px) {
        .kbn-carousel-col {
          flex: 0 0 85%;
          max-width: 85%;
        }
      }
    `
    document.head.append(style)
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Which column the card belongs to per the same rules the server uses. */
function columnOf(card: KanbanCard): ColumnKind {
  if (card.status === 'closed') {
    if (card.tempered === true) return 'tempered'
    if (card.tempered === false) return 'composted'
    return 'awaitingReview'
  }
  if (card.tags?.includes('draft')) return 'drafts'
  return 'inFlight'
}

function findCardById(resp: KanbanResponse | null, id: string): KanbanCard | null {
  if (!resp) return null
  for (const col of [resp.columns.drafts, resp.columns.inFlight, resp.columns.awaitingReview, resp.columns.tempered, resp.columns.composted]) {
    const hit = col.find(c => c.id === id)
    if (hit) return hit
  }
  return null
}

/**
 * Format an ISO timestamp as a short relative string ("3h", "2d", "Apr 18").
 */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const now = Date.now()
  const diff = now - t
  const sec = diff / 1000
  if (sec < 60) return 'just now'
  const min = sec / 60
  if (min < 60) return `${Math.floor(min)}m`
  const hr = min / 60
  if (hr < 24) return `${Math.floor(hr)}h`
  const day = hr / 24
  if (day < 7) return `${Math.floor(day)}d`
  // Older — show a month-day stamp.
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
