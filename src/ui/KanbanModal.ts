/**
 * KanbanModal — global view of constitution-tagged fibers grouped by lifecycle.
 *
 * Six flat columns: Ideas → Drafts → In flight → Awaiting → Tempered → Composted.
 * Each column scrolls vertically; the body scrolls horizontally when six columns
 * don't all fit. About 3 columns are visible at typical widths.
 *
 * Ideas (off-screen left at rest) and Tempered/Composted (off-screen right at
 * rest) are the speculative + verdict edges; the central three columns
 * (Drafts → In flight → Awaiting) carry the active constitution lifecycle.
 *
 * Interaction: drag a card to any column (HTML5 DnD). Both surfaces POST to
 * /kanban/transition with {fiberId, target}. Click a card body to open in vellum.
 */

/** Column identifier — also doubles as the API target. */
type ColumnKind = 'ideas' | 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered' | 'composted'

const COLUMN_TITLES: Record<ColumnKind, string> = {
  ideas: 'Ideas',
  drafts: 'Drafts',
  inFlight: 'In flight',
  awaitingReview: 'Awaiting review',
  tempered: 'Tempered',
  composted: 'Composted',
}

const COLUMN_BLURBS: Record<ColumnKind, string> = {
  ideas: 'Speculative — sketches and brainstorms tagged `idea`. Off-screen left; promote to drafts when ready to write a real constitution.',
  drafts: 'Tagged constitution+draft. Refine until ready, then promote.',
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
  /**
   * Session UUID of the most recently dispatched worker. Non-null enables
   * the "Resume previous" button on awaiting-review cards. Populated from
   * `shuttle.session.id` in the fiber frontmatter (written by the Shuttle
   * daemon via `shuttle-ctl session-set` after a successful worker spawn).
   */
  sessionId?: string
  /**
   * `shuttle.agent` — the agent to dispatch with. Present when the fiber
   * has a shuttle block and the block specifies an agent.
   */
  shuttleAgent?: string
  /**
   * `shuttle.kind` — `oneshot` (default) or `standing`. Present iff the
   * fiber has a shuttle block. Drives the kind segmented control in the
   * fiber-detail modal and reveals the schedule/tz row when standing.
   */
  shuttleKind?: 'oneshot' | 'standing'
  /**
   * `shuttle.schedule.expr` — 5-field cron expression for standing roles.
   * Absent on one-shot fibers and on fibers without a shuttle block.
   */
  shuttleSchedule?: string
  /**
   * `shuttle.schedule.tz` — IANA timezone name paired with `shuttleSchedule`.
   * Absent when `shuttleSchedule` is absent.
   */
  shuttleTz?: string
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
    ideas: KanbanCard[]
    drafts: KanbanCard[]
    inFlight: KanbanCard[]
    awaitingReview: KanbanCard[]
    tempered: KanbanCard[]
    composted: KanbanCard[]
  }
  totals: { ideas: number; drafts: number; inFlight: number; awaitingReview: number; tempered: number; composted: number }
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

interface KanbanScrollSnapshot {
  bodyLeft: number
  columns: Partial<Record<ColumnKind, number>>
}

/**
 * Snapshot of a single per-card directive textarea. Captured before each
 * re-render so the polling-driven DOM rebuild doesn't drop user-typed
 * directive text on the floor.
 */
interface ReviewDirectiveSnapshot {
  value: string
  selectionStart: number
  selectionEnd: number
  isFocused: boolean
}

export class KanbanModal {
  private readonly onOpenFiber: (card: KanbanCard) => void
  private readonly onOpenWorker?: (tmuxSessionName: string) => void
  private readonly onStashClick?: () => void
  private readonly apiBase: string
  private readonly handleDocumentKeyDown = (e: KeyboardEvent): void => this.handleKanbanKeyDown(e)

  private container: HTMLDivElement | null = null
  private body: HTMLDivElement | null = null
  private statusEl: HTMLDivElement | null = null
  private subtitleEl: HTMLDivElement | null = null
  private liveEl: HTMLDivElement | null = null
  private bannerEl: HTMLDivElement | null = null
  private inflightFetchToken = 0
  /**
   * Whether the initial Ideas-off-screen-left scroll has been applied yet.
   * Distinct from `hasClaimedInitialFocus` (focus tracker) and from
   * `lastResponse === null` (which gets set in fetchAndRender *before* render
   * runs, so it can't gate first-render behavior).
   */
  private hasInitialScrollApplied = false
  private dragSourceId: string | null = null
  private dragAutoScrollFrame: number | null = null
  private dragAutoScrollVelocity = 0
  private bannerTimer: number | null = null
  private hasClaimedInitialFocus = false
  /** Null = global (default). Set by mount(...{cityScope}); cleared by
   *  unmount(). */
  private cityScope: KanbanCityScope | null = null
  /** Bug 3: lightweight auto-poll while mounted. 15s default. */
  private pollTimer: number | null = null
  private readonly pollIntervalMs = 15_000
  /** Intermediate fiber-detail modal — one instance, re-used across opens. */
  private detailModal: FiberDetailModal | null = null

  constructor(options: KanbanModalOptions) {
    this.onOpenFiber = options.onOpenFiber
    this.onOpenWorker = options.onOpenWorker
    this.onStashClick = options.onStashClick
    this.apiBase = options.apiBase ?? `http://${window.location.hostname}:4004`
    this.injectStyles()
    this.detailModal = new FiberDetailModal(
      this.apiBase,
      this.onOpenFiber,
      () => { void this.fetchAndRender() },
    )
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
    document.addEventListener('keydown', this.handleDocumentKeyDown, true)
    void this.fetchAndRender()
    this.startPolling()
  }

  /**
   * Tear down a mounted kanban. Safe to call when not mounted — no-op.
   * The host is responsible for removing the host div itself; we only own
   * the kanban's container (already a child of host).
   */
  unmount(): void {
    if (this.container === null) return
    document.removeEventListener('keydown', this.handleDocumentKeyDown, true)
    this.stopPolling()
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

    // Bug 3: manual refresh button in the header. Lightens the refresh
    // affordance (faded icon) so it doesn't compete with the stash trigger.
    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'kbn-refresh-btn'
    refreshBtn.setAttribute('aria-label', 'Refresh kanban')
    refreshBtn.title = 'Refresh'
    refreshBtn.textContent = '↻'
    refreshBtn.addEventListener('click', () => {
      void this.fetchAndRender()
      this.announce('Refreshing…')
    })

    header.append(titleWrap, this.statusEl, refreshBtn)

    // The `⊕ Global` scope-escape affordance retired with the thumb-index
    // global-navigation constitution
    // ([[ai-futures/portolan/vellum-reader/constitution-thumb-index-global-navigation]]).
    // Scope flips happen by closing the modal and re-opening on the
    // desired scope (the `← index` thumb-index button promotes city →
    // global; the chrome bar's K chip + `k` hotkey re-enter on the
    // currently-focused scope). Cards-in-place stay city-scoped for the
    // life of this mount.

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
    this.body.className = 'kbn-body'
    this.body.addEventListener('wheel', (e) => this.handleBodyWheel(e), { passive: false })
    this.body.addEventListener('scroll', () => this.updateBodyScrollAffordance(), { passive: true })
    this.body.addEventListener('dragover', (e) => this.handleBodyDragOver(e))
    this.body.addEventListener('dragleave', (e) => this.handleBodyDragLeave(e))
    this.body.addEventListener('drop', () => this.stopDragAutoScroll())

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
    this.hasClaimedInitialFocus = false
    this.hasInitialScrollApplied = false
    this.stopDragAutoScroll()
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

    const scrollSnapshot = this.captureScrollSnapshot()
    // Capture the typed text in any per-card directive textareas so the
    // poll-driven re-render doesn't blow away the user's mid-flight input.
    // The corresponding restore happens after the column rebuild.
    const directives = this.captureReviewDirectives()
    const { columns, totals, temperedTotal, staleness } = data
    this.statusEl.textContent =
      (totals.ideas > 0 ? `${totals.ideas} ideas · ` : '') +
      `${totals.drafts} drafts · ${totals.inFlight} in flight · ` +
      `${totals.awaitingReview} awaiting review · ${totals.tempered}/${temperedTotal} tempered` +
      (totals.composted > 0 ? ` · ${totals.composted} composted` : '')

    this.body.innerHTML = ''
    this.body.classList.remove('kbn-body-zoomed')

    const colOrder: ColumnKind[] = ['ideas', 'drafts', 'inFlight', 'awaitingReview', 'tempered', 'composted']
    for (const kind of colOrder) {
      this.body.append(
        this.renderColumn(kind, columns[kind], staleness, kind === 'tempered' ? temperedTotal : undefined),
      )
    }

    this.restoreScrollSnapshot(scrollSnapshot)
    this.restoreReviewDirectives(directives)
    // First render only: scroll Ideas off-screen left so In Flight sits in
    // the center of the viewport (with Drafts left-of-center and Awaiting
    // review right-of-center). Mirrors how Tempered/Composted live off-
    // screen right — the speculative + verdict edges flank the active
    // lifecycle. Gated on `hasInitialScrollApplied` rather than
    // `lastResponse === null` because lastResponse is set in
    // fetchAndRender BEFORE render runs, so it can't be used to detect
    // the first call.
    if (!this.hasInitialScrollApplied) this.scrollIdeasOffscreenLeft()
    this.claimInitialFocus()
    this.updateBodyScrollAffordance()
    window.requestAnimationFrame(() => this.updateBodyScrollAffordance())
    this.lastResponse = data
  }

  /**
   * On first render, scroll the body so Ideas (the leftmost column) sits
   * just off the left edge — Drafts becomes the first visible column.
   * Subsequent renders preserve user scroll via captureScrollSnapshot/
   * restoreScrollSnapshot, so this only fires once per modal mount.
   */
  private scrollIdeasOffscreenLeft(): void {
    if (!this.body) return
    let applied = false
    const apply = (): void => {
      if (!this.body) return
      const ideasCol = this.body.querySelector<HTMLElement>('.kbn-col[data-column="ideas"]')
      if (!ideasCol) return
      // Position so Drafts is flush with the left padding (and In Flight
      // sits centered, given equal column widths). Read the computed
      // widths after layout settles.
      const bodyStyle = window.getComputedStyle(this.body)
      const gap = parseFloat(bodyStyle.gap || '10') || 10
      this.body.scrollLeft = ideasCol.offsetWidth + gap
      applied = true
      this.hasInitialScrollApplied = true
    }
    apply()
    // Defer through multiple frames AND a setTimeout so the scroll lands
    // after `claimInitialFocus`'s rAF — focusing a column-head inside Ideas
    // resets scrollLeft to 0 even with `preventScroll: true` (Chromium quirk
    // observed against off-screen columns). Running last wins.
    window.requestAnimationFrame(() => {
      apply()
      window.requestAnimationFrame(apply)
      window.setTimeout(apply, 0)
    })
    // If the Ideas column wasn't in the DOM yet (race during very-first
    // render with empty data), `apply` no-ops; leave the flag false so the
    // next render call retries. The deferred frames above will succeed
    // in steady state.
    if (!applied) this.hasInitialScrollApplied = false
  }

  /**
   * Capture typed text + selection state from every review-cluster
   * directive textarea, keyed by the owning card's fiber id. Used to
   * preserve user input across poll-driven re-renders (which blow away
   * the DOM via innerHTML = '').
   *
   * Empty textareas are omitted so we don't bother re-applying nothing.
   */
  private captureReviewDirectives(): Map<string, ReviewDirectiveSnapshot> {
    const out = new Map<string, ReviewDirectiveSnapshot>()
    if (!this.body) return out
    for (const ta of this.body.querySelectorAll<HTMLTextAreaElement>('.kbn-review-textarea')) {
      const card = ta.closest<HTMLElement>('.kbn-card[data-fiber-id]')
      const fiberId = card?.dataset.fiberId
      if (!fiberId) continue
      const value = ta.value
      if (!value) continue
      const isFocused = document.activeElement === ta
      out.set(fiberId, {
        value,
        selectionStart: ta.selectionStart,
        selectionEnd: ta.selectionEnd,
        isFocused,
      })
    }
    return out
  }

  /**
   * Restore directive text + selection + focus into newly-rendered review
   * clusters. Also fires an `input` event so the Requeue/Resume buttons
   * pick up the restored value and update their disabled state.
   */
  private restoreReviewDirectives(snap: Map<string, ReviewDirectiveSnapshot>): void {
    if (!this.body || snap.size === 0) return
    for (const [fiberId, s] of snap) {
      const card = this.body.querySelector<HTMLElement>(
        `.kbn-card[data-fiber-id="${CSS.escape(fiberId)}"]`,
      )
      const ta = card?.querySelector<HTMLTextAreaElement>('.kbn-review-textarea')
      if (!ta) continue
      ta.value = s.value
      // Re-fire input so the action buttons re-evaluate their enabled state.
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      if (s.isFocused) {
        ta.focus({ preventScroll: true })
        try {
          ta.setSelectionRange(s.selectionStart, s.selectionEnd)
        } catch {
          /* selection out of bounds — ignore */
        }
      }
    }
  }

  private claimInitialFocus(): void {
    if (this.hasClaimedInitialFocus || !this.body) return

    this.hasClaimedInitialFocus = true
    window.requestAnimationFrame(() => {
      if (!this.body) return
      const active = document.activeElement
      if (active instanceof HTMLElement && this.container?.contains(active)) return
      this.body.querySelector<HTMLElement>('.kbn-col-head')?.focus({ preventScroll: true })
    })
  }

  private captureScrollSnapshot(): KanbanScrollSnapshot | null {
    if (!this.body) return null

    const columns: Partial<Record<ColumnKind, number>> = {}
    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col[data-column]')) {
      const kind = col.dataset.column as ColumnKind | undefined
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      if (kind && list) columns[kind] = list.scrollTop
    }

    return { bodyLeft: this.body.scrollLeft, columns }
  }

  private restoreScrollSnapshot(snapshot: KanbanScrollSnapshot | null): void {
    if (!this.body || !snapshot) return

    const restore = (): void => {
      if (!this.body) return
      this.body.scrollLeft = snapshot.bodyLeft
      for (const [kind, scrollTop] of Object.entries(snapshot.columns) as [ColumnKind, number][]) {
        const list = this.body.querySelector<HTMLElement>(`.kbn-col[data-column="${kind}"] .kbn-col-list`)
        if (list) list.scrollTop = scrollTop
      }
      this.updateBodyScrollAffordance()
    }

    restore()
    window.requestAnimationFrame(restore)
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
      this.stopDragAutoScroll()
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
        this.stopDragAutoScroll()
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
    name.setAttribute('aria-label', `View details for fiber ${card.name}`)
    name.textContent = card.name
    name.addEventListener('click', (e) => {
      e.stopPropagation()
      this.detailModal?.open(card)
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

    // Tags + date row, with Feature 4 inline tag editor.
    const meta = document.createElement('div')
    meta.className = 'kbn-card-meta'

    const tagWrap = document.createElement('div')
    tagWrap.className = 'kbn-card-tags'
    const visibleTags = (card.tags ?? []).filter(t => t !== 'constitution')
    const moreCount = Math.max(0, visibleTags.length - 4)
    const shownTags = visibleTags.slice(0, 4)
    for (const t of shownTags) {
      const chip = document.createElement('span')
      chip.className = 'kbn-tag'
      chip.textContent = t
      tagWrap.append(chip)
    }
    if (moreCount > 0) {
      const more = document.createElement('span')
      more.className = 'kbn-tag'
      more.textContent = `+${moreCount}`
      tagWrap.append(more)
    }

    // Feature 4: tag edit button — opens an inline tag editor on the card.
    // Shown on all cards that aren't stale-origin (mutation has nowhere to
    // land when the agent is disconnected).
    if (!isStale) {
      const editBtn = document.createElement('button')
      editBtn.type = 'button'
      editBtn.className = 'kbn-tag-edit-btn'
      editBtn.setAttribute('aria-label', 'Edit tags')
      editBtn.title = 'Edit tags'
      editBtn.textContent = '✎'
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.openTagEditor(el, card, tagWrap, editBtn)
      })
      tagWrap.append(editBtn)
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

    // Review action cluster on awaiting-review cards. Non-stale only —
    // stale-origin cards have nowhere to land for mutations.
    if (kind === 'awaitingReview' && !isStale) {
      el.append(this.renderReviewCluster(card))
    }

    // Click outside any button → open fiber detail modal.
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, textarea')) return
      this.detailModal?.open(card)
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

  /** Bug 3: lightweight auto-poll while mounted. 15s interval. */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => {
      void this.fetchAndRender()
    }, this.pollIntervalMs)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** POST endpoint for tag edits, with `?cityId=` when scoped. */
  private kanbanTagsUrl(): string {
    const base = `${this.apiBase}/kanban/tags`
    if (!this.cityScope) return base
    return `${base}?cityId=${encodeURIComponent(this.cityScope.cityId)}`
  }

  /** POST endpoint for review-comment directives, with `?cityId=` when scoped. */
  private reviewCommentUrl(): string {
    const base = `${this.apiBase}/kanban/review-comment`
    if (!this.cityScope) return base
    return `${base}?cityId=${encodeURIComponent(this.cityScope.cityId)}`
  }

  /**
   * Open an inline tag editor on a kanban card, replacing the tag display
   * with removable chips + add input + save/cancel buttons.
   *
   * The editor manages its own DOM inside the card: it caches the original
   * tag set, renders editable chips (× to remove) and an add-input, and on
   * save POSTs the full set to /kanban/tags. On error it shows the banner
   * and restores the original chips; on success `fetchAndRender` refreshes
   * the entire board.
   */
  private openTagEditor(
    cardEl: HTMLElement,
    card: KanbanCard,
    tagWrap: HTMLElement,
    editBtn: HTMLButtonElement,
  ): void {
    const originalTags = (card.tags ?? []).filter(t => t !== 'constitution')

    // Build the editing container.
    const editor = document.createElement('div')
    editor.className = 'kbn-tag-editor'

    // Chips row: each tag as a removable chip + the text input replacing
    // the add-button concept (the input doubles as the "add new" affordance).
    const chipsRow = document.createElement('div')
    chipsRow.className = 'kbn-tag-editor-chips'

    const currentTags = [...originalTags]
    const renderChips = (): void => {
      chipsRow.innerHTML = ''
      for (let i = 0; i < currentTags.length; i++) {
        const t = currentTags[i]
        const chip = document.createElement('span')
        chip.className = 'kbn-tag kbn-tag-editable'

        const label = document.createElement('span')
        label.textContent = t

        const remBtn = document.createElement('button')
        remBtn.type = 'button'
        remBtn.className = 'kbn-tag-remove'
        remBtn.setAttribute('aria-label', `Remove tag ${t}`)
        remBtn.textContent = '×'
        remBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          currentTags.splice(i, 1)
          renderChips()
          addInput.focus()
        })

        chip.append(label, remBtn)
        chipsRow.append(chip)
      }

      // Re-append the add-input after the chips row rebuild.
      chipsRow.append(addInput)
    }

    // Text input for adding a new tag. Enter commits the tag + stays in edit
    // mode so the user can add multiple tags without re-clicking ✎.
    const addInput = document.createElement('input')
    addInput.type = 'text'
    addInput.className = 'kbn-tag-add-input'
    addInput.placeholder = 'new tag…'
    addInput.setAttribute('aria-label', 'Add a new tag')
    addInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const val = addInput.value.trim()
      if (val && !currentTags.includes(val)) {
        currentTags.push(val)
        renderChips()
      }
      addInput.value = ''
    })
    // Stop propagation on mousedown so clicks on the input don't trigger
    // the card-level click handler (which opens the fiber in vellum).
    addInput.addEventListener('mousedown', (e) => e.stopPropagation())

    // Action row: Save + Cancel buttons.
    const actionsRow = document.createElement('div')
    actionsRow.className = 'kbn-tag-editor-actions'

    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'kbn-action kbn-action-inFlight'
    saveBtn.textContent = 'Save'
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Commit any pending input value first.
      const pending = addInput.value.trim()
      if (pending && !currentTags.includes(pending)) {
        currentTags.push(pending)
      }
      addInput.value = ''
      saveBtn.disabled = true
      saveBtn.textContent = 'Saving…'
      void this.saveTags(card, currentTags, cardEl, editor, tagWrap, editBtn)
    })

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'kbn-action kbn-action-drafts'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.restoreTagDisplay(originalTags, tagWrap, editBtn)
    })

    actionsRow.append(cancelBtn, saveBtn)

    renderChips()
    editor.append(chipsRow, actionsRow)

    // Replace the tagWrap content with the editor.
    tagWrap.innerHTML = ''
    tagWrap.append(editor)

    // Focus the input after mount.
    window.requestAnimationFrame(() => addInput.focus())
  }

  /**
   * POST the tag set to /kanban/tags and handle the response. On success,
   * refetch the board (the card will re-render with the new tags). On
   * failure, restore the original display and show the error banner.
   */
  private async saveTags(
    card: KanbanCard,
    tags: string[],
    _cardEl: HTMLElement,
    _editor: HTMLElement,
    tagWrap: HTMLElement,
    editBtn: HTMLButtonElement,
  ): Promise<void> {
    const originalTags = (card.tags ?? []).filter(t => t !== 'constitution')
    try {
      const res = await fetch(this.kanbanTagsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, tags }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `${res.status}` })) as { error?: string }
        throw new Error(errBody.error || `Tags save failed: ${res.status}`)
      }
      this.announce(`Tags saved for “${card.name}”.`)
      // Refetch — the server response includes the refreshed card, but
      // a full refetch is simplest and keeps the board consistent.
      void this.fetchAndRender()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't save tags for “${card.name}”: ${msg}`, 'error')
      this.announce(`Tags save failed: ${msg}`)
      this.restoreTagDisplay(originalTags, tagWrap, editBtn)
    }
  }

  /**
   * Restore the tag display after a cancel or save failure. Removes the
   * editor DOM and re-inserts the original tag chips + edit button.
   */
  private restoreTagDisplay(
    originalTags: string[],
    tagWrap: HTMLElement,
    editBtn: HTMLButtonElement,
  ): void {
    tagWrap.innerHTML = ''
    const moreCount = Math.max(0, originalTags.length - 4)
    const shownTags = originalTags.slice(0, 4)
    for (const t of shownTags) {
      const chip = document.createElement('span')
      chip.className = 'kbn-tag'
      chip.textContent = t
      tagWrap.append(chip)
    }
    if (moreCount > 0) {
      const more = document.createElement('span')
      more.className = 'kbn-tag'
      more.textContent = `+${moreCount}`
      tagWrap.append(more)
    }
    tagWrap.append(editBtn)
  }

  /**
   * Render the review action cluster appended to awaiting-review cards.
   *
   * Layout:
   *   [textarea — directive input, compact 2-row]
   *   [Requeue fresh ▸] [Resume previous ▸]
   *   [temper]  [compost]   ← secondary, smaller
   *
   * "Requeue fresh" is disabled until the textarea has non-empty content.
   * "Resume previous" is enabled when the fiber has a stored session UUID
   *   (shuttle.session.id ≠ null), disabled otherwise with an explanatory
   *   tooltip. Both buttons require a non-empty directive.
   * "Temper" and "Compost" are secondary conveniences; drag is primary.
   */
  private renderReviewCluster(card: KanbanCard): HTMLElement {
    const cluster = document.createElement('div')
    cluster.className = 'kbn-review-cluster'

    // Textarea for the directive.
    const textarea = document.createElement('textarea')
    textarea.className = 'kbn-review-textarea'
    textarea.placeholder = 'Add a directive for the next worker…'
    textarea.rows = 2
    textarea.setAttribute('aria-label', 'Review directive')
    // Stop card-level click from triggering open-in-vellum while editing.
    textarea.addEventListener('mousedown', (e) => e.stopPropagation())
    textarea.addEventListener('click', (e) => e.stopPropagation())

    // Primary action row.
    const primaryRow = document.createElement('div')
    primaryRow.className = 'kbn-review-primary'

    const requeueBtn = document.createElement('button')
    requeueBtn.type = 'button'
    requeueBtn.className = 'kbn-action kbn-action-inFlight kbn-review-btn'
    requeueBtn.textContent = 'Requeue fresh ▸'
    requeueBtn.disabled = true
    requeueBtn.setAttribute('aria-label', 'Requeue fiber with directive (fresh worker)')
    requeueBtn.title = 'Type a directive above to enable'

    // "Resume previous" is enabled only when the fiber has a stored session UUID.
    const hasSession = !!card.sessionId
    const resumeBtn = document.createElement('button')
    resumeBtn.type = 'button'
    resumeBtn.className = hasSession
      ? 'kbn-action kbn-review-btn'
      : 'kbn-action kbn-review-btn kbn-review-btn--disabled'
    resumeBtn.textContent = 'Resume previous ▸'
    resumeBtn.disabled = true  // also requires non-empty directive; see input handler
    resumeBtn.setAttribute('aria-label', hasSession
      ? 'Resume previous worker session with directive'
      : 'Resume previous worker session (no session available)')
    resumeBtn.title = hasSession
      ? 'Type a directive above to enable'
      : 'No prior session stored — dispatch a fresh worker first'

    primaryRow.append(requeueBtn, resumeBtn)

    // Secondary action row: temper / compost (drag alternatives).
    const secondaryRow = document.createElement('div')
    secondaryRow.className = 'kbn-review-secondary'

    const temperBtn = document.createElement('button')
    temperBtn.type = 'button'
    temperBtn.className = 'kbn-action kbn-action-tempered kbn-review-secondary-btn'
    temperBtn.textContent = 'Temper'
    temperBtn.setAttribute('aria-label', `Temper fiber: ${card.name}`)
    temperBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.transition(card, 'tempered')
    })

    const compostBtn = document.createElement('button')
    compostBtn.type = 'button'
    compostBtn.className = 'kbn-action kbn-action-drafts kbn-review-secondary-btn'
    compostBtn.textContent = 'Compost'
    compostBtn.setAttribute('aria-label', `Compost fiber: ${card.name}`)
    compostBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.transition(card, 'composted')
    })

    secondaryRow.append(temperBtn, compostBtn)

    // Wire: enable action buttons only when textarea has content.
    // Requeue fresh: always available when textarea non-empty.
    // Resume previous: available when textarea non-empty AND session exists.
    textarea.addEventListener('input', () => {
      const hasContent = textarea.value.trim().length > 0
      requeueBtn.disabled = !hasContent
      if (hasContent) {
        requeueBtn.title = 'Record directive and requeue as in-flight (fresh worker)'
      } else {
        requeueBtn.title = 'Type a directive above to enable'
      }
      if (hasSession) {
        resumeBtn.disabled = !hasContent
        if (hasContent) {
          resumeBtn.title = 'Record directive and resume previous worker session'
        } else {
          resumeBtn.title = 'Type a directive above to enable'
        }
      }
      // If !hasSession, resumeBtn stays disabled regardless of textarea.
    })

    // Wire: "Requeue fresh" click.
    requeueBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.requeueFresh(card, textarea.value.trim(), requeueBtn, resumeBtn)
    })

    // Wire: "Resume previous" click.
    resumeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (hasSession && textarea.value.trim()) {
        void this.resumePrevious(card, textarea.value.trim(), requeueBtn, resumeBtn)
      }
    })

    cluster.append(textarea, primaryRow, secondaryRow)
    return cluster
  }

  /**
   * Record a review directive and requeue the fiber as in-flight (fresh worker).
   *
   * Two-step: POST /kanban/review-comment to record the directive, then
   * POST /kanban/transition {target: 'inFlight'} to move the card. Both must
   * succeed; if the directive write fails the transition is skipped and the
   * card stays in awaiting-review.
   */
  private async requeueFresh(
    card: KanbanCard,
    directive: string,
    requeueBtn: HTMLButtonElement,
    resumeBtn: HTMLButtonElement,
  ): Promise<void> {
    if (!directive) return
    requeueBtn.disabled = true
    resumeBtn.disabled = true
    requeueBtn.textContent = 'Requeueing…'

    try {
      // Step 1: record the directive.
      const commentRes = await fetch(this.reviewCommentUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, directive, resumeMode: 'fresh' }),
      })
      if (!commentRes.ok) {
        const errBody = await commentRes.json().catch(() => ({ error: `${commentRes.status}` })) as { error?: string }
        throw new Error(errBody.error || `Review comment failed: ${commentRes.status}`)
      }

      // Step 2: move to inFlight.
      const transRes = await fetch(this.transitionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, target: 'inFlight' }),
      })
      if (!transRes.ok) {
        const errBody = await transRes.json().catch(() => ({ error: `${transRes.status}` })) as { error?: string }
        throw new Error(errBody.error || `Transition failed: ${transRes.status}`)
      }

      this.announce(`Requeued "${card.name}" with directive.`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't requeue "${card.name}": ${msg}`, 'error')
      // Restore buttons.
      requeueBtn.textContent = 'Requeue fresh ▸'
      requeueBtn.disabled = false
      resumeBtn.disabled = !card.sessionId || directive.length === 0
      return
    }

    await this.fetchAndRender()
  }

  /**
   * Record a review directive and requeue the fiber requesting resume of the
   * previous worker session.
   *
   * Same two-step as requeueFresh, but POSTs `resumeMode: 'previous'`. The
   * Shuttle dispatcher reads the resume_mode from the review-comment event
   * and invokes the harness-appropriate resume command (e.g.
   * `claude --resume <session-id>`). Only callable when `card.sessionId` is
   * set (button is disabled otherwise by renderReviewCluster).
   */
  private async resumePrevious(
    card: KanbanCard,
    directive: string,
    requeueBtn: HTMLButtonElement,
    resumeBtn: HTMLButtonElement,
  ): Promise<void> {
    if (!directive || !card.sessionId) return
    requeueBtn.disabled = true
    resumeBtn.disabled = true
    resumeBtn.textContent = 'Resuming…'

    try {
      // Step 1: record the directive with resume intent.
      const commentRes = await fetch(this.reviewCommentUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, directive, resumeMode: 'previous' }),
      })
      if (!commentRes.ok) {
        const errBody = await commentRes.json().catch(() => ({ error: `${commentRes.status}` })) as { error?: string }
        throw new Error(errBody.error || `Review comment failed: ${commentRes.status}`)
      }

      // Step 2: move to inFlight — Shuttle picks it up and resumes the session.
      const transRes = await fetch(this.transitionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, target: 'inFlight' }),
      })
      if (!transRes.ok) {
        const errBody = await transRes.json().catch(() => ({ error: `${transRes.status}` })) as { error?: string }
        throw new Error(errBody.error || `Transition failed: ${transRes.status}`)
      }

      this.announce(`Resuming previous session for "${card.name}" with directive.`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't resume "${card.name}": ${msg}`, 'error')
      // Restore buttons on failure.
      resumeBtn.textContent = 'Resume previous ▸'
      resumeBtn.disabled = false
      requeueBtn.disabled = directive.length === 0
      return
    }

    await this.fetchAndRender()
  }

  /** Update DOM that depends on `cityScope` after a scope swap. */
  private updateScopeChrome(): void {
    if (this.subtitleEl) this.subtitleEl.textContent = this.subtitleText()
    // The `⊕ Global` scope-escape button retired with the thumb-index
    // global-navigation constitution — scope flips no longer happen
    // in-place from inside the kanban tab.
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
    this.updateBodyScrollAffordance()
  }

  /**
   * Shift+vertical wheel pans the five-column board horizontally. Ordinary
   * vertical wheel events stay native so column and page scrolling do not fight
   * trackpads.
   */
  private handleBodyWheel(e: WheelEvent): void {
    if (!this.body || this.body.classList.contains('kbn-body-zoomed')) return
    if (this.body.scrollWidth <= this.body.clientWidth) return
    if (!e.shiftKey) return

    const verticalDelta = e.deltaY
    const horizontalDelta = e.deltaX
    if (Math.abs(verticalDelta) < Math.abs(horizontalDelta)) return

    const boardDelta = verticalDelta
    if (boardDelta === 0) return

    e.preventDefault()
    this.body.scrollLeft += boardDelta
    this.updateBodyScrollAffordance()
  }

  private handleKanbanKeyDown(e: KeyboardEvent): void {
    if (!this.body || e.key !== 'Tab') return

    const active = document.activeElement as HTMLElement | null
    const heads = Array.from(this.body.querySelectorAll<HTMLElement>('.kbn-col-head'))
      .filter(head => head.offsetParent !== null)
    if (heads.length === 0) return

    const activeHead = active?.closest<HTMLElement>('.kbn-col-head')
    const activeCol = active?.closest<HTMLElement>('.kbn-col')
    const activeColHead = activeCol?.querySelector<HTMLElement>('.kbn-col-head') ?? null
    const currentHead = activeHead ?? activeColHead
    const fallbackIndex = this.currentColumnIndexFromScroll(heads)
    const index = currentHead && this.body.contains(currentHead)
      ? heads.indexOf(currentHead)
      : fallbackIndex

    if (index === -1) return

    e.preventDefault()
    e.stopPropagation()

    const nextIndex = (index + (e.shiftKey ? -1 : 1) + heads.length) % heads.length
    const next = heads[nextIndex]
    next.focus({ preventScroll: true })
    this.scrollColumnToStart(next.closest<HTMLElement>('.kbn-col'))
    this.updateBodyScrollAffordance()
  }

  private currentColumnIndexFromScroll(heads: HTMLElement[]): number {
    if (!this.body) return -1

    const bodyLeft = this.body.getBoundingClientRect().left
    const distances = heads.map((head, index) => {
      const col = head.closest<HTMLElement>('.kbn-col')
      const distance = col ? Math.abs(col.getBoundingClientRect().left - bodyLeft) : Number.POSITIVE_INFINITY
      return { index, distance }
    })
    distances.sort((a, b) => a.distance - b.distance)
    return distances[0]?.index ?? -1
  }

  private scrollColumnToStart(col: HTMLElement | null): void {
    if (!this.body || !col) return

    const bodyLeft = this.body.getBoundingClientRect().left
    const colLeft = col.getBoundingClientRect().left
    const paddingLeft = Number.parseFloat(window.getComputedStyle(this.body).paddingLeft) || 0
    this.body.scrollTo({
      left: this.body.scrollLeft + colLeft - bodyLeft - paddingLeft,
      behavior: 'smooth',
    })
  }

  private handleBodyDragOver(e: DragEvent): void {
    if (!this.body || !this.dragSourceId || this.body.classList.contains('kbn-body-zoomed')) return
    if (this.body.scrollWidth <= this.body.clientWidth) return

    const rect = this.body.getBoundingClientRect()
    const edge = 128
    const maxStep = 42
    const leftPressure = Math.max(0, edge - (e.clientX - rect.left))
    const rightPressure = Math.max(0, edge - (rect.right - e.clientX))
    const direction = rightPressure > 0 ? 1 : leftPressure > 0 ? -1 : 0
    const pressure = Math.max(leftPressure, rightPressure) / edge

    this.dragAutoScrollVelocity = direction === 0
      ? 0
      : direction * Math.max(10, Math.round(Math.pow(pressure, 1.35) * maxStep))

    if (this.dragAutoScrollVelocity === 0) {
      this.stopDragAutoScroll()
      return
    }

    this.startDragAutoScroll()
  }

  private handleBodyDragLeave(e: DragEvent): void {
    if (!this.body) return
    if (e.relatedTarget && this.body.contains(e.relatedTarget as Node)) return
    this.stopDragAutoScroll()
  }

  private startDragAutoScroll(): void {
    if (this.dragAutoScrollFrame !== null) return

    const tick = (): void => {
      if (!this.body || !this.dragSourceId || this.dragAutoScrollVelocity === 0) {
        this.stopDragAutoScroll()
        return
      }

      this.body.scrollLeft += this.dragAutoScrollVelocity
      this.updateBodyScrollAffordance()
      this.dragAutoScrollFrame = window.requestAnimationFrame(tick)
    }

    this.dragAutoScrollFrame = window.requestAnimationFrame(tick)
  }

  private stopDragAutoScroll(): void {
    this.dragAutoScrollVelocity = 0
    if (this.dragAutoScrollFrame === null) return
    window.cancelAnimationFrame(this.dragAutoScrollFrame)
    this.dragAutoScrollFrame = null
  }

  private updateBodyScrollAffordance(): void {
    if (!this.body) return
    if (this.body.classList.contains('kbn-body-zoomed')) {
      this.body.classList.remove('kbn-can-scroll-left', 'kbn-can-scroll-right')
      return
    }

    const maxScrollLeft = this.body.scrollWidth - this.body.clientWidth
    this.body.classList.toggle('kbn-can-scroll-left', this.body.scrollLeft > 1)
    this.body.classList.toggle('kbn-can-scroll-right', this.body.scrollLeft < maxScrollLeft - 1)
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
      /* Refresh ↻ button in the header. Faded, low-prominence. */
      .kbn-refresh-btn {
        flex-shrink: 0;
        width: 24px;
        height: 24px;
        padding: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 3px;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 14px;
        line-height: 1;
        color: rgba(122, 112, 104, 0.55);
        cursor: pointer;
        transition: color 120ms ease, border-color 120ms ease;
      }
      .kbn-refresh-btn:hover,
      .kbn-refresh-btn:focus-visible {
        color: #7A7068;
        border-color: rgba(122, 112, 104, 0.22);
        outline: none;
      }
      .kbn-refresh-btn:focus-visible {
        outline: 1px dashed #7A7068;
        outline-offset: 2px;
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
      /* Five-column track with a three-column viewport. Drafts/Open/Awaiting
         are visible at rest; horizontal scroll reveals Tempered and
         Composted without clone-loop carousel state. Vertical scroll is
         native/per-column; Shift+vertical wheel pans horizontally. Deliberately
         no scroll-snap: trackpad deltas are small, and snap makes side-to-side
         gestures feel stuck. */
      .kbn-body {
        flex: 1;
        display: flex;
        gap: 10px;
        padding: 12px;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        min-height: 0;
      }
      .kbn-body.kbn-can-scroll-right {
        -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent 100%);
        mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent 100%);
      }
      .kbn-body.kbn-can-scroll-left {
        -webkit-mask-image: linear-gradient(to right, transparent 0, #000 28px);
        mask-image: linear-gradient(to right, transparent 0, #000 28px);
      }
      .kbn-body.kbn-can-scroll-left.kbn-can-scroll-right {
        -webkit-mask-image: linear-gradient(to right, transparent 0, #000 28px, #000 calc(100% - 28px), transparent 100%);
        mask-image: linear-gradient(to right, transparent 0, #000 28px, #000 calc(100% - 28px), transparent 100%);
      }
      .kbn-col {
        flex: 0 0 max(260px, calc((100% - 20px) / 3));
        display: flex; flex-direction: column;
        min-height: 0;
        max-height: 100%;
        background: #F4F0E8;
        border: 1px solid rgba(46, 42, 38, 0.10);
        border-radius: 3px;
        overflow: hidden;
        transition: background 150ms ease, border-color 150ms ease;
      }
      /* When zoomed, the body becomes a single-column view. */
      .kbn-body.kbn-body-zoomed {
        overflow-x: hidden;
      }
      .kbn-body.kbn-body-zoomed .kbn-col:not(.kbn-col-zoomed) {
        display: none;
      }
      .kbn-body.kbn-body-zoomed .kbn-col-zoomed {
        flex: 1 1 auto;
        min-width: 0;
      }
      /* When zoomed, tile cards as a CSS grid filling the available width. */
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
      /* Feature 4: tag edit affordance — ✎ button next to tags */
      .kbn-tag-edit-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        margin: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 3px;
        font-size: 11px;
        line-height: 1;
        color: #C8BFB3;
        cursor: pointer;
        transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
        flex-shrink: 0;
      }
      .kbn-tag-edit-btn:hover,
      .kbn-tag-edit-btn:focus-visible {
        color: #7A7068;
        background: rgba(46, 42, 38, 0.08);
        border-color: rgba(122, 112, 104, 0.3);
        outline: none;
      }
      .kbn-tag-edit-btn:focus-visible {
        outline: 1px dashed #7A7068;
        outline-offset: 1px;
      }
      /* Tag editor: inline card-level editor for adding/removing tags */
      .kbn-tag-editor {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .kbn-tag-editor-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
      }
      .kbn-tag-editable {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: rgba(46, 42, 38, 0.07);
        padding: 1px 2px 1px 5px;
      }
      .kbn-tag-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        padding: 0;
        margin: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 2px;
        font-size: 11px;
        line-height: 1;
        color: #9A7068;
        cursor: pointer;
        transition: color 120ms ease, background 120ms ease;
      }
      .kbn-tag-remove:hover,
      .kbn-tag-remove:focus-visible {
        color: #A03030;
        background: rgba(160, 48, 48, 0.10);
        outline: none;
      }
      .kbn-tag-add-input {
        flex: 0 1 80px;
        min-width: 60px;
        max-width: 120px;
        height: 18px;
        padding: 0 5px;
        border: 1px solid rgba(122, 112, 104, 0.22);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.6);
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10px;
        color: #2E2A26;
        outline: none;
      }
      .kbn-tag-add-input:focus {
        border-color: rgba(122, 112, 104, 0.5);
        background: #FFFFFF;
      }
      .kbn-tag-add-input::placeholder {
        color: #C8BFB3;
      }
      .kbn-tag-editor-actions {
        display: flex;
        gap: 6px;
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

      /* ── Review action cluster (awaiting-review cards only) ─────────────── */
      /* Appended below the card body. Delimited from content by a top border.
         Primary row: textarea + Requeue fresh + Resume previous (disabled).
         Secondary row: temper + compost (drag alternatives, smaller). */
      .kbn-review-cluster {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-top: 8px;
        margin-top: 4px;
        border-top: 1px dashed rgba(154, 123, 53, 0.28);
      }
      .kbn-review-textarea {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        min-height: 44px;
        padding: 5px 8px;
        border: 1px solid rgba(122, 112, 104, 0.28);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.65);
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 12.5px;
        line-height: 1.4;
        color: #2E2A26;
        outline: none;
        transition: border-color 120ms ease, background 120ms ease;
      }
      .kbn-review-textarea:focus {
        border-color: rgba(154, 123, 53, 0.55);
        background: #FFFFFF;
      }
      .kbn-review-textarea::placeholder {
        color: #C8BFB3;
        font-style: italic;
      }
      .kbn-review-primary {
        display: flex;
        gap: 6px;
      }
      .kbn-review-btn {
        flex: 1;
        font-size: 10px;
        padding: 3px 6px;
        white-space: nowrap;
      }
      /* Disabled "Resume previous" uses a distinct muted style. */
      .kbn-review-btn--disabled {
        background: rgba(46, 42, 38, 0.03);
        border-color: rgba(46, 42, 38, 0.12);
        color: #C8BFB3;
        cursor: not-allowed;
      }
      .kbn-review-btn--disabled:hover {
        background: rgba(46, 42, 38, 0.03);
        color: #C8BFB3;
      }
      .kbn-review-secondary {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
      }
      .kbn-review-secondary-btn {
        font-size: 9.5px;
        padding: 2px 7px;
        opacity: 0.75;
      }
      .kbn-review-secondary-btn:hover {
        opacity: 1;
      }

      @media (max-width: 1100px) {
        .kbn-col {
          flex: 0 0 85%;
          min-width: 0;
        }
      }

      /* ── Fiber Detail Modal ──────────────────────────────────────────────── */
      /* Fixed-position overlay with a centered dialog. Opens on card click as
         a lightweight alternative to full vellum. Styled to match the kanban's
         warm-paper palette: #EDE8E0 body, #E5DED2 header, gold accents. */
      .kbn-detail-overlay {
        position: fixed;
        inset: 0;
        background: rgba(46, 42, 38, 0.38);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        padding: 24px;
        box-sizing: border-box;
      }
      .kbn-detail-dialog {
        background: #EDE8E0;
        border: 1px solid rgba(46, 42, 38, 0.18);
        border-radius: 4px;
        box-shadow: 0 8px 32px rgba(46, 42, 38, 0.25), 0 2px 8px rgba(46, 42, 38, 0.12);
        /* Big landscape modal — most of the screen, wider than tall.
           90vw caps at 1280px; 80vh keeps a generous landscape ratio. */
        width: min(90vw, 1280px);
        height: min(80vh, 800px);
        max-height: calc(100vh - 48px);
        display: flex;
        flex-direction: column;
        font-family: var(--font-main, 'EB Garamond', serif);
        color: #2E2A26;
        overflow: hidden;
      }
      .kbn-detail-header {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 16px 20px 12px;
        background: #E5DED2;
        border-bottom: 1px solid rgba(46, 42, 38, 0.12);
        flex-shrink: 0;
      }
      .kbn-detail-title {
        flex: 1;
        font-size: 19px;
        font-weight: 600;
        line-height: 1.3;
        cursor: pointer;
        text-decoration: underline;
        text-decoration-color: transparent;
        text-underline-offset: 3px;
        transition: color 120ms ease, text-decoration-color 120ms ease;
      }
      .kbn-detail-title:hover,
      .kbn-detail-title:focus-visible {
        color: #6B5520;
        text-decoration-color: rgba(154, 123, 53, 0.5);
        outline: none;
      }
      .kbn-detail-title-hint {
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 12px;
        font-style: italic;
        color: #B8AC9E;
        margin-left: 6px;
        font-weight: 400;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      .kbn-detail-title:hover .kbn-detail-title-hint,
      .kbn-detail-title:focus-visible .kbn-detail-title-hint {
        opacity: 1;
      }
      .kbn-detail-close {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        padding: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 3px;
        font-size: 16px;
        line-height: 1;
        color: #9A9088;
        cursor: pointer;
        transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .kbn-detail-close:hover,
      .kbn-detail-close:focus-visible {
        color: #2E2A26;
        background: rgba(46, 42, 38, 0.10);
        border-color: rgba(46, 42, 38, 0.20);
        outline: none;
      }
      .kbn-detail-id {
        padding: 6px 20px 10px;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 11px;
        color: #B8AC9E;
        letter-spacing: 0.01em;
        background: #E5DED2;
        border-bottom: 1px solid rgba(46, 42, 38, 0.12);
        flex-shrink: 0;
        cursor: pointer;
        transition: color 120ms ease;
      }
      .kbn-detail-id:hover,
      .kbn-detail-id:focus-visible {
        color: #6B5520;
        outline: none;
      }
      /* Body is a two-tier layout: top row (outcome | history) above a
         horizontal controls strip (dispatch + parent). Outcome and history
         share the bulk of the height; the controls strip auto-sizes to its
         content. */
      .kbn-detail-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }
      /* Top tier: two columns, outcome (left) and history (right). */
      .kbn-detail-top {
        flex: 1;
        display: flex;
        flex-direction: row;
        min-height: 0;
        overflow: hidden;
      }
      .kbn-detail-col-outcome {
        flex: 1 1 58%;
        display: flex;
        flex-direction: column;
        min-width: 0;
        border-right: 1px solid rgba(46, 42, 38, 0.10);
      }
      .kbn-detail-col-history {
        flex: 1 1 42%;
        display: flex;
        flex-direction: column;
        min-width: 0;
        background: rgba(229, 222, 210, 0.35);
      }
      /* Bottom strip: horizontal controls (dispatch + parent). Each control
         block has a fixed-width label + content pair, separated by gentle
         dividers. Auto-grows in a pinch but never above its content's needs. */
      .kbn-detail-strip {
        flex-shrink: 0;
        display: flex;
        flex-direction: row;
        gap: 0;
        background: #E8E1D5;
        border-top: 1px solid rgba(46, 42, 38, 0.12);
      }
      .kbn-detail-strip-block {
        flex: 1 1 0;
        padding: 12px 18px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      .kbn-detail-strip-block + .kbn-detail-strip-block {
        border-left: 1px solid rgba(46, 42, 38, 0.10);
      }
      .kbn-detail-strip-heading {
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #9A9088;
      }
      .kbn-detail-section {
        padding: 14px 20px;
        border-bottom: 1px solid rgba(46, 42, 38, 0.08);
      }
      /* Outcome section grows to fill its column so the textarea can fill height. */
      .kbn-detail-col-outcome .kbn-detail-section {
        flex: 1;
        display: flex;
        flex-direction: column;
        border-bottom: none;
        min-height: 0;
      }
      /* History section: heading + scrolling list. */
      .kbn-detail-col-history .kbn-detail-section {
        flex: 1;
        display: flex;
        flex-direction: column;
        border-bottom: none;
        min-height: 0;
      }
      /* The scrolling list of history events. */
      .kbn-detail-history-list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding-right: 4px;
      }
      .kbn-detail-history-event {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 8px 10px;
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid rgba(122, 112, 104, 0.16);
        border-radius: 3px;
      }
      .kbn-detail-history-event-meta {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        color: #B8AC9E;
        flex-wrap: wrap;
      }
      .kbn-detail-history-event-time {
        color: #9A9088;
      }
      .kbn-detail-history-event-kind {
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        padding: 1px 6px;
        border-radius: 8px;
        background: rgba(154, 123, 53, 0.10);
        color: #9A7B35;
      }
      .kbn-detail-history-event-kind.kbn-detail-history-event-kind-editorial {
        background: rgba(122, 112, 104, 0.12);
        color: #7A7068;
      }
      .kbn-detail-history-event-summary {
        font-size: 12.5px;
        line-height: 1.45;
        color: #2E2A26;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 9em;
        overflow: hidden;
        position: relative;
      }
      .kbn-detail-history-event-summary.expanded {
        max-height: none;
      }
      .kbn-detail-history-event-toggle {
        align-self: flex-start;
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 11.5px;
        font-style: italic;
        color: #9A7B35;
        background: transparent;
        border: none;
        padding: 0;
        margin-top: 2px;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
        text-decoration-color: rgba(154, 123, 53, 0.4);
      }
      .kbn-detail-history-event-toggle:hover { color: #6B5520; }
      .kbn-detail-history-empty {
        font-size: 12.5px;
        color: #B8AC9E;
        font-style: italic;
        padding: 8px 0;
      }
      .kbn-detail-section-heading {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #9A9088;
        margin-bottom: 8px;
        flex-shrink: 0;
      }
      .kbn-detail-textarea {
        width: 100%;
        box-sizing: border-box;
        resize: none;
        flex: 1;
        min-height: 0;
        padding: 10px 12px;
        border: 1px solid rgba(122, 112, 104, 0.28);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.65);
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 14px;
        line-height: 1.5;
        color: #2E2A26;
        outline: none;
        transition: border-color 120ms ease, background 120ms ease;
      }
      .kbn-detail-textarea:focus {
        border-color: rgba(154, 123, 53, 0.55);
        background: #FFFCF6;
      }
      .kbn-detail-textarea::placeholder {
        color: #C8BFB3;
        font-style: italic;
      }
      .kbn-detail-field-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 0;
      }
      .kbn-detail-field-row:last-child { margin-bottom: 0; }
      .kbn-detail-label {
        font-size: 12px;
        color: #7A7068;
        width: 56px;
        flex-shrink: 0;
      }
      /* In the strip, controls span the full width and the parent dropdown
         anchors above the input rather than below (no room beneath). */
      .kbn-detail-strip .kbn-detail-parent-dropdown {
        top: auto;
        bottom: calc(100% + 2px);
        max-height: 280px;
      }
      .kbn-detail-strip .kbn-detail-current-parent {
        margin-bottom: 4px;
      }
      .kbn-detail-select {
        flex: 1;
        padding: 5px 8px;
        border: 1px solid rgba(122, 112, 104, 0.28);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.65);
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 13px;
        color: #2E2A26;
        outline: none;
        cursor: pointer;
        transition: border-color 120ms ease;
      }
      .kbn-detail-select:focus {
        border-color: rgba(154, 123, 53, 0.55);
      }
      .kbn-detail-muted {
        font-size: 12.5px;
        color: #9A9088;
        font-style: italic;
      }
      .kbn-detail-current-parent {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 11px;
        color: #7A7068;
        margin-bottom: 8px;
      }
      .kbn-detail-current-parent.kbn-detail-pending-change {
        color: #9A7B35;
        font-weight: 600;
      }
      .kbn-detail-parent-wrap {
        position: relative;
        margin-bottom: 6px;
      }
      .kbn-detail-parent-input {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 10px;
        border: 1px solid rgba(122, 112, 104, 0.28);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.65);
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 13px;
        color: #2E2A26;
        outline: none;
        transition: border-color 120ms ease;
      }
      .kbn-detail-parent-input:focus {
        border-color: rgba(154, 123, 53, 0.55);
        background: #FFFCF6;
      }
      .kbn-detail-parent-input::placeholder {
        color: #C8BFB3;
        font-style: italic;
      }
      /* Generic input used by the dispatch strip's cron + tz fields. Mirrors
         .kbn-detail-parent-input but with tighter padding so it sits flush
         with the segmented control next to it. */
      .kbn-detail-input {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        padding: 5px 8px;
        border: 1px solid rgba(122, 112, 104, 0.28);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.65);
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 13px;
        color: #2E2A26;
        outline: none;
        transition: border-color 120ms ease, background 120ms ease;
      }
      .kbn-detail-input:focus {
        border-color: rgba(154, 123, 53, 0.55);
        background: #FFFCF6;
      }
      .kbn-detail-input::placeholder {
        color: #C8BFB3;
        font-style: italic;
      }
      .kbn-detail-input-mono {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 12px;
      }
      /* Timezone input is narrower than cron — IANA names are short. */
      .kbn-detail-input-tz {
        flex: 0 0 140px;
      }
      /* Schedule row only matters when kind=standing; show/hide is via
         inline display:none from the kind toggle handler. Class kept as
         a marker for future targeted styling. */
      .kbn-detail-field-row-schedule { /* presentational marker only */ }
      /* Two-segment radiogroup styled as a pill switch. Used for the
         dispatch kind (one-shot / standing); reads as a setting, not a
         button cluster. */
      .kbn-detail-segmented {
        display: inline-flex;
        flex: 1;
        border: 1px solid rgba(122, 112, 104, 0.28);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.55);
        overflow: hidden;
      }
      .kbn-detail-segment {
        flex: 1;
        padding: 5px 10px;
        background: transparent;
        border: none;
        border-right: 1px solid rgba(122, 112, 104, 0.20);
        cursor: pointer;
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 12.5px;
        color: #7A7068;
        transition: background 100ms ease, color 100ms ease;
      }
      .kbn-detail-segment:last-child { border-right: none; }
      .kbn-detail-segment:hover {
        background: rgba(154, 123, 53, 0.06);
        color: #2E2A26;
      }
      .kbn-detail-segment-active {
        background: rgba(154, 123, 53, 0.18);
        color: #2E2A26;
        font-weight: 600;
      }
      .kbn-detail-segment-active:hover {
        background: rgba(154, 123, 53, 0.22);
      }
      .kbn-detail-segment-name {
        display: inline-block;
      }
      /* Dropdown that appears below the parent input */
      .kbn-detail-parent-dropdown {
        position: absolute;
        top: calc(100% + 2px);
        left: 0;
        right: 0;
        background: #FAF8F5;
        border: 1px solid rgba(122, 112, 104, 0.28);
        border-radius: 2px;
        box-shadow: 0 4px 12px rgba(46, 42, 38, 0.14);
        max-height: 200px;
        overflow-y: auto;
        z-index: 10000;
      }
      .kbn-detail-parent-option {
        display: flex;
        flex-direction: column;
        gap: 1px;
        width: 100%;
        text-align: left;
        padding: 7px 10px;
        background: transparent;
        border: none;
        border-bottom: 1px solid rgba(46, 42, 38, 0.06);
        cursor: pointer;
        font-family: inherit;
        transition: background 80ms ease;
      }
      .kbn-detail-parent-option:last-child { border-bottom: none; }
      .kbn-detail-parent-option:hover,
      .kbn-detail-parent-option:focus {
        background: rgba(154, 123, 53, 0.08);
        outline: none;
      }
      .kbn-detail-parent-option[data-depth="1"] .kbn-detail-parent-option-name {
        font-weight: 600;
      }
      .kbn-detail-parent-option-name {
        font-size: 13px;
        color: #2E2A26;
      }
      .kbn-detail-parent-option-id {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10px;
        color: #B8AC9E;
      }
      .kbn-detail-parent-empty {
        font-size: 12.5px;
        color: #B8AC9E;
        font-style: italic;
        cursor: default;
      }
      .kbn-detail-parent-empty:hover { background: transparent; }
      .kbn-detail-clear-parent {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10px;
        color: #9A9088;
        background: transparent;
        border: 1px solid rgba(122, 112, 104, 0.22);
        border-radius: 2px;
        padding: 2px 7px;
        cursor: pointer;
        letter-spacing: 0.02em;
        transition: color 120ms ease, background 120ms ease;
      }
      .kbn-detail-clear-parent:hover {
        color: #2E2A26;
        background: rgba(46, 42, 38, 0.06);
      }
      /* Footer row: vellum link (left) + error + cancel/save (right) */
      .kbn-detail-footer {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 20px;
        border-top: 1px solid rgba(46, 42, 38, 0.12);
        background: #E5DED2;
        flex-shrink: 0;
      }
      .kbn-detail-vellum-btn {
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 13px;
        font-style: italic;
        color: #9A7B35;
        background: transparent;
        border: none;
        padding: 0;
        cursor: pointer;
        transition: color 120ms ease;
        text-decoration: underline;
        text-underline-offset: 2px;
        text-decoration-color: rgba(154, 123, 53, 0.4);
      }
      .kbn-detail-vellum-btn:hover {
        color: #6B5520;
      }
      .kbn-detail-vellum-btn:focus { outline: none; }
      .kbn-detail-vellum-btn:focus-visible {
        outline: 1px dashed #9A7B35;
        outline-offset: 2px;
      }
      .kbn-detail-error {
        flex: 1;
        font-size: 12px;
        color: #8B3A28;
        background: rgba(178, 78, 60, 0.10);
        border: 1px solid rgba(178, 78, 60, 0.30);
        padding: 3px 8px;
        border-radius: 2px;
      }
      .kbn-detail-footer-right {
        display: flex;
        gap: 6px;
        margin-left: auto;
      }
      .kbn-detail-save-btn {
        min-width: 56px;
      }
    `
    document.head.append(style)
  }
}

// ── Fiber Detail Modal ───────────────────────────────────────────────────────
//
// Intermediate console-style modal for editing a kanban card without opening
// full vellum. Opens on card click; provides editable outcome, shuttle agent
// selector, and parent-fiber autocomplete. "Open in vellum" deep-links to
// the fiber's full editor for more advanced changes.

interface FiberSearchResult {
  id: string
  name: string
  depth: number
}

/**
 * FiberDetailModal — lightweight overlay for inline fiber editing.
 *
 * Lifecycle: `open(card)` mounts the overlay; `close()` tears it down.
 * Only one instance is open at a time — opening while already open closes
 * the previous modal first (avoids stacked overlays from rapid clicking).
 *
 * Three editable fields:
 *   - `outcome`      : free-text textarea, replaces the fiber's outcome field
 *   - `shuttleAgent` : dropdown of available agents (loaded from /shuttle/agents)
 *   - `parentId`     : autocomplete search against /kanban/fiber-search;
 *                      `null` means top-level (felt unnest)
 *
 * The host kanban's `fetchAndRender()` is called on successful save so the
 * card updates in place without requiring a full page reload.
 */
class FiberDetailModal {
  private overlay: HTMLElement | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private searchDebounce: number | null = null
  private readonly apiBase: string
  private readonly onOpenFiber: (card: KanbanCard) => void
  private readonly onSaved: () => void

  constructor(
    apiBase: string,
    onOpenFiber: (card: KanbanCard) => void,
    onSaved: () => void,
  ) {
    this.apiBase = apiBase
    this.onOpenFiber = onOpenFiber
    this.onSaved = onSaved
  }

  open(card: KanbanCard): void {
    // Tear down any existing open modal first (rapid re-click).
    this.close()

    const overlay = document.createElement('div')
    overlay.className = 'kbn-detail-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', `Fiber: ${card.name}`)

    // Close on backdrop click.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close()
    })

    const dialog = document.createElement('div')
    dialog.className = 'kbn-detail-dialog'

    // ── Header ──────────────────────────────────────────────────────────────
    // The title and the id are both vellum entry points — click either to
    // close the modal and open the fiber's full editor. Hover reveals the
    // affordance ("→ vellum" hint on the title).
    const header = document.createElement('div')
    header.className = 'kbn-detail-header'

    const title = document.createElement('div')
    title.className = 'kbn-detail-title'
    title.setAttribute('role', 'button')
    title.setAttribute('tabindex', '0')
    title.setAttribute('aria-label', `Open ${card.name} in vellum`)
    title.title = 'Click to open in vellum'
    const titleText = document.createElement('span')
    titleText.textContent = card.name
    const titleHint = document.createElement('span')
    titleHint.className = 'kbn-detail-title-hint'
    titleHint.textContent = '→ vellum'
    title.append(titleText, titleHint)
    const openInVellum = (e: Event) => {
      e.stopPropagation()
      this.close()
      this.onOpenFiber(card)
    }
    title.addEventListener('click', openInVellum)
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') openInVellum(e)
    })

    const pill = document.createElement('span')
    pill.className = `kbn-pill kbn-pill-${card.status === 'closed' ? 'closed' : card.status === 'active' ? 'active' : 'open'}`
    pill.textContent = card.status || 'open'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'kbn-detail-close'
    closeBtn.setAttribute('aria-label', 'Close fiber detail')
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', () => this.close())

    header.append(title, pill, closeBtn)

    // ── ID breadcrumb ────────────────────────────────────────────────────────
    // Also clickable; same vellum entry path as the title.
    const idEl = document.createElement('div')
    idEl.className = 'kbn-detail-id'
    idEl.setAttribute('role', 'button')
    idEl.setAttribute('tabindex', '0')
    idEl.setAttribute('aria-label', `Open ${card.id} in vellum`)
    idEl.title = 'Click to open in vellum'
    idEl.textContent = card.id
    idEl.addEventListener('click', openInVellum)
    idEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') openInVellum(e)
    })

    // ── Outcome ──────────────────────────────────────────────────────────────
    // Lives in the left column; the section flex-grows so the textarea fills
    // the available height. Internal scrolling within the textarea handles
    // long outcomes — no `rows` attribute needed.
    const outcomeSec = this.buildSection('Outcome')
    const outcomeTextarea = document.createElement('textarea')
    outcomeTextarea.className = 'kbn-detail-textarea'
    outcomeTextarea.placeholder = 'What was decided or learned…'
    outcomeTextarea.value = card.outcome ?? ''
    outcomeTextarea.addEventListener('mousedown', (e) => e.stopPropagation())
    outcomeTextarea.addEventListener('click', (e) => e.stopPropagation())
    outcomeSec.append(outcomeTextarea)

    // Track the *original* outcome to detect changes on save.
    const originalOutcome = card.outcome ?? ''

    // ── History panel (right column, top tier) ──────────────────────────────
    // Read-only event chain for the fiber. Shown alongside the outcome so the
    // user can see "what happened so far" without leaving the modal.
    const historySec = this.buildSection('History')
    const historyList = document.createElement('div')
    historyList.className = 'kbn-detail-history-list'
    const historyLoading = document.createElement('div')
    historyLoading.className = 'kbn-detail-history-empty'
    historyLoading.textContent = 'Loading…'
    historyList.append(historyLoading)
    historySec.append(historyList)
    void this.loadHistory(card.id, historyList)

    // ── Dispatch (shuttle options) ────────────────────────────────────────────
    // Console-style editor for the fiber's shuttle frontmatter block. Lets the
    // human tune the dispatch contract — agent, kind, schedule cadence — from
    // the kanban without opening vellum or the terminal. Lives in the bottom
    // strip as a horizontal control block. Three rows:
    //   1. Agent select (always visible)
    //   2. Kind segmented control (oneshot / standing)
    //   3. Schedule + tz inline pair (revealed only when kind=standing)
    //
    // Server-side, agent-only changes route through `shuttle-ctl set-model`
    // (preserves session.id + review history). Kind/schedule/tz changes
    // trigger a full uninstall + install/repeat — destructive of session
    // history, but cheap state for drafts.
    let agentSelect: HTMLSelectElement | null = null
    const originalAgent = card.shuttleAgent ?? ''
    const originalKind: 'oneshot' | 'standing' = card.shuttleKind ?? 'oneshot'
    const originalSchedule = card.shuttleSchedule ?? ''
    const originalTz = card.shuttleTz ?? 'Europe/Paris'

    let selectedKind: 'oneshot' | 'standing' = originalKind
    let selectedSchedule = originalSchedule
    let selectedTz = originalTz

    const dispatchSec = this.buildStripBlock('Dispatch')

    // Row 1: agent
    const agentRow = document.createElement('div')
    agentRow.className = 'kbn-detail-field-row'

    const agentLabel = document.createElement('label')
    agentLabel.className = 'kbn-detail-label'
    agentLabel.textContent = 'Agent'

    agentSelect = document.createElement('select')
    agentSelect.className = 'kbn-detail-select'

    // Placeholder while loading.
    const loadingOpt = document.createElement('option')
    loadingOpt.value = ''
    loadingOpt.textContent = 'Loading agents…'
    agentSelect.append(loadingOpt)

    agentLabel.setAttribute('for', 'kbn-detail-agent')
    agentSelect.id = 'kbn-detail-agent'
    agentRow.append(agentLabel, agentSelect)
    dispatchSec.append(agentRow)

    // Load agents from /shuttle/agents async.
    void this.loadAgents(agentSelect, originalAgent)

    // Row 2: kind segmented control
    const kindRow = document.createElement('div')
    kindRow.className = 'kbn-detail-field-row'

    const kindLabel = document.createElement('span')
    kindLabel.className = 'kbn-detail-label'
    kindLabel.textContent = 'Kind'

    const kindSegmented = document.createElement('div')
    kindSegmented.className = 'kbn-detail-segmented'
    kindSegmented.setAttribute('role', 'radiogroup')
    kindSegmented.setAttribute('aria-label', 'Dispatch kind')

    // Schedule row needs to be defined before the kind buttons can toggle its
    // visibility — declared up here, populated below.
    const scheduleRow = document.createElement('div')
    scheduleRow.className = 'kbn-detail-field-row kbn-detail-field-row-schedule'

    const buildKindBtn = (
      value: 'oneshot' | 'standing',
      title: string,
      hint: string,
    ): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-detail-segment'
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-checked', value === selectedKind ? 'true' : 'false')
      btn.dataset.kind = value
      if (value === selectedKind) btn.classList.add('kbn-detail-segment-active')
      btn.title = hint

      const name = document.createElement('span')
      name.className = 'kbn-detail-segment-name'
      name.textContent = title
      btn.append(name)

      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (selectedKind === value) return
        selectedKind = value
        for (const sibling of kindSegmented.querySelectorAll<HTMLButtonElement>('button')) {
          const isActive = sibling.dataset.kind === value
          sibling.classList.toggle('kbn-detail-segment-active', isActive)
          sibling.setAttribute('aria-checked', isActive ? 'true' : 'false')
        }
        scheduleRow.style.display = value === 'standing' ? '' : 'none'
        // Surface a sensible cron + tz default when promoting to standing
        // for the first time so the user has something to edit rather than
        // an empty input that fails validation on save.
        if (value === 'standing') {
          if (!selectedSchedule) {
            selectedSchedule = '0 9 * * 1-5'
            scheduleInput.value = selectedSchedule
          }
          if (!selectedTz) {
            selectedTz = 'Europe/Paris'
            tzInput.value = selectedTz
          }
        }
      })
      return btn
    }

    const oneshotBtn = buildKindBtn('oneshot', 'One-shot', 'Single dispatch on enable')
    const standingBtn = buildKindBtn('standing', 'Standing', 'Recurring cron-scheduled role')
    kindSegmented.append(oneshotBtn, standingBtn)
    kindRow.append(kindLabel, kindSegmented)
    dispatchSec.append(kindRow)

    // Row 3: schedule + tz (visible only when kind=standing)
    const scheduleLabel = document.createElement('label')
    scheduleLabel.className = 'kbn-detail-label'
    scheduleLabel.textContent = 'Cron'
    scheduleLabel.setAttribute('for', 'kbn-detail-schedule')

    const scheduleInput = document.createElement('input')
    scheduleInput.type = 'text'
    scheduleInput.id = 'kbn-detail-schedule'
    scheduleInput.className = 'kbn-detail-input kbn-detail-input-mono'
    scheduleInput.placeholder = '0 9 * * 1-5'
    scheduleInput.value = selectedSchedule
    scheduleInput.title = '5-field cron · e.g. 0 9 * * 1-5 (weekdays 09:00)'
    scheduleInput.addEventListener('input', () => {
      selectedSchedule = scheduleInput.value
    })
    scheduleInput.addEventListener('mousedown', (e) => e.stopPropagation())
    scheduleInput.addEventListener('click', (e) => e.stopPropagation())

    const tzInput = document.createElement('input')
    tzInput.type = 'text'
    tzInput.className = 'kbn-detail-input kbn-detail-input-tz'
    tzInput.placeholder = 'Europe/Paris'
    tzInput.value = selectedTz
    tzInput.title = 'IANA timezone name'
    tzInput.setAttribute('aria-label', 'Timezone (IANA name)')
    tzInput.addEventListener('input', () => {
      selectedTz = tzInput.value
    })
    tzInput.addEventListener('mousedown', (e) => e.stopPropagation())
    tzInput.addEventListener('click', (e) => e.stopPropagation())

    scheduleRow.append(scheduleLabel, scheduleInput, tzInput)
    scheduleRow.style.display = selectedKind === 'standing' ? '' : 'none'
    dispatchSec.append(scheduleRow)

    // ── Parent fiber ──────────────────────────────────────────────────────────
    // Shows the current parent (derived from the id path) and an autocomplete
    // field for selecting a new one. Lives in the bottom strip too.
    const parentSec = this.buildStripBlock('Parent fiber')

    // Derive current parent from id segments.
    const idSegments = card.id.split('/')
    const currentParentId = idSegments.length > 1
      ? idSegments.slice(0, -1).join('/')
      : null

    // State for the selected parent (null = top-level; undefined = no change).
    let selectedParentId: string | null | undefined = undefined

    const currentParentEl = document.createElement('div')
    currentParentEl.className = 'kbn-detail-current-parent'
    currentParentEl.textContent = currentParentId
      ? `↳ ${currentParentId}`
      : '↳ top-level (no parent)'

    const parentSearchWrap = document.createElement('div')
    parentSearchWrap.className = 'kbn-detail-parent-wrap'

    const parentInput = document.createElement('input')
    parentInput.type = 'text'
    parentInput.className = 'kbn-detail-parent-input'
    parentInput.placeholder = 'Search for a new parent…'
    parentInput.setAttribute('aria-label', 'Search parent fiber')
    parentInput.setAttribute('autocomplete', 'off')
    // Stop card-level clicks propagating (there's no card here, but be defensive).
    parentInput.addEventListener('mousedown', (e) => e.stopPropagation())
    parentInput.addEventListener('click', (e) => e.stopPropagation())

    const parentDropdown = document.createElement('div')
    parentDropdown.className = 'kbn-detail-parent-dropdown'
    parentDropdown.style.display = 'none'

    const clearParentBtn = document.createElement('button')
    clearParentBtn.type = 'button'
    clearParentBtn.className = 'kbn-detail-clear-parent'
    clearParentBtn.textContent = 'Make top-level'
    clearParentBtn.setAttribute('aria-label', 'Remove parent (make top-level)')
    clearParentBtn.style.display = currentParentId ? '' : 'none'
    clearParentBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      selectedParentId = null
      currentParentEl.textContent = '↳ top-level (will be moved)'
      currentParentEl.classList.add('kbn-detail-pending-change')
      parentInput.value = ''
      parentDropdown.style.display = 'none'
      clearParentBtn.style.display = 'none'
    })

    // Search on input with debounce.
    parentInput.addEventListener('input', () => {
      const q = parentInput.value.trim()
      if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
      this.searchDebounce = window.setTimeout(() => {
        void this.searchParents(q, card.id, parentDropdown, (result) => {
          selectedParentId = result.id
          currentParentEl.textContent = `↳ ${result.id} (pending)`
          currentParentEl.classList.add('kbn-detail-pending-change')
          parentInput.value = result.name
          parentDropdown.style.display = 'none'
          clearParentBtn.style.display = ''
        })
      }, 200)
    })

    // Show top-level results on focus if empty.
    parentInput.addEventListener('focus', () => {
      if (!parentInput.value.trim()) {
        void this.searchParents('', card.id, parentDropdown, (result) => {
          selectedParentId = result.id
          currentParentEl.textContent = `↳ ${result.id} (pending)`
          currentParentEl.classList.add('kbn-detail-pending-change')
          parentInput.value = result.name
          parentDropdown.style.display = 'none'
          clearParentBtn.style.display = ''
        })
      }
    })

    // Hide dropdown on blur (with delay to allow click on option).
    parentInput.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!parentDropdown.matches(':focus-within')) {
          parentDropdown.style.display = 'none'
        }
      }, 150)
    })

    parentSearchWrap.append(parentInput, parentDropdown)
    parentSec.append(currentParentEl, parentSearchWrap, clearParentBtn)

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = document.createElement('div')
    footer.className = 'kbn-detail-footer'

    const vellumBtn = document.createElement('button')
    vellumBtn.type = 'button'
    vellumBtn.className = 'kbn-detail-vellum-btn'
    vellumBtn.textContent = 'Open in vellum →'
    vellumBtn.setAttribute('aria-label', `Open ${card.name} in vellum`)
    vellumBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
      this.onOpenFiber(card)
    })

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'kbn-action kbn-action-drafts'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
    })

    const errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.style.display = 'none'

    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'kbn-action kbn-action-inFlight kbn-detail-save-btn'
    saveBtn.textContent = 'Save'
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const changes: {
        outcome?: string
        shuttleAgent?: string
        shuttleKind?: 'oneshot' | 'standing'
        shuttleSchedule?: string
        shuttleTz?: string
        parentId?: string | null
      } = {}

      const newOutcome = outcomeTextarea.value.trim()
      if (newOutcome !== originalOutcome.trim()) changes.outcome = newOutcome

      if (agentSelect) {
        const newAgent = agentSelect.value
        if (newAgent && newAgent !== originalAgent) changes.shuttleAgent = newAgent
      }

      // Kind / schedule / tz: a reshape is anything that diverges from the
      // fiber's current shuttle block. When the kind changes, send all three
      // (the server uses them to reshape the block); when only schedule/tz
      // changes within standing, send those plus the (unchanged) kind so the
      // server's reshape path resolves consistently.
      const newSchedule = scheduleInput.value.trim()
      const newTz = tzInput.value.trim()
      const kindChanged = selectedKind !== originalKind
      const scheduleChanged = selectedKind === 'standing' &&
        (newSchedule !== originalSchedule || newTz !== originalTz)
      if (kindChanged || scheduleChanged) {
        changes.shuttleKind = selectedKind
        if (selectedKind === 'standing') {
          if (!newSchedule) {
            errorEl.textContent = 'A cron expression is required for standing roles.'
            errorEl.style.display = ''
            return
          }
          changes.shuttleSchedule = newSchedule
          changes.shuttleTz = newTz || 'UTC'
        }
      }

      if (selectedParentId !== undefined) changes.parentId = selectedParentId

      if (Object.keys(changes).length === 0) {
        this.close()
        return
      }

      saveBtn.disabled = true
      saveBtn.textContent = 'Saving…'
      errorEl.style.display = 'none'

      void this.save(card.id, changes, saveBtn, errorEl)
    })

    const footerRight = document.createElement('div')
    footerRight.className = 'kbn-detail-footer-right'
    footerRight.append(cancelBtn, saveBtn)

    footer.append(vellumBtn, errorEl, footerRight)

    // ── Assemble ─────────────────────────────────────────────────────────────
    // Body has two tiers:
    //   • Top tier: outcome (left) | history (right). Both fill the height
    //     of the tier; outcome via internal textarea scroll, history via
    //     overflow-y on its event list.
    //   • Bottom strip: dispatch + parent as side-by-side control blocks.
    //     The parent dropdown anchors above its input so it doesn't get
    //     clipped by the strip's bottom edge.
    const body = document.createElement('div')
    body.className = 'kbn-detail-body'

    const top = document.createElement('div')
    top.className = 'kbn-detail-top'

    const colOutcome = document.createElement('div')
    colOutcome.className = 'kbn-detail-col-outcome'
    colOutcome.append(outcomeSec)

    const colHistory = document.createElement('div')
    colHistory.className = 'kbn-detail-col-history'
    colHistory.append(historySec)

    top.append(colOutcome, colHistory)

    const strip = document.createElement('div')
    strip.className = 'kbn-detail-strip'
    strip.append(dispatchSec, parentSec)

    body.append(top, strip)
    dialog.append(header, idEl, body, footer)
    overlay.append(dialog)
    document.body.append(overlay)
    this.overlay = overlay

    // Escape to close.
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close()
    }
    document.addEventListener('keydown', this.escapeHandler, true)

    // Focus the outcome textarea after mount.
    window.requestAnimationFrame(() => outcomeTextarea.focus())
  }

  close(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler, true)
      this.escapeHandler = null
    }
    if (this.searchDebounce !== null) {
      window.clearTimeout(this.searchDebounce)
      this.searchDebounce = null
    }
    this.overlay?.remove()
    this.overlay = null
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private buildSection(label: string): HTMLElement {
    const sec = document.createElement('div')
    sec.className = 'kbn-detail-section'
    const heading = document.createElement('div')
    heading.className = 'kbn-detail-section-heading'
    heading.textContent = label
    sec.append(heading)
    return sec
  }

  /**
   * Build a control block for the bottom strip. Same heading idiom as a
   * regular section but with horizontal-strip styling: padded vertically,
   * separated by left-borders rather than top-borders, and sized by content.
   */
  private buildStripBlock(label: string): HTMLElement {
    const block = document.createElement('div')
    block.className = 'kbn-detail-strip-block'
    const heading = document.createElement('div')
    heading.className = 'kbn-detail-strip-heading'
    heading.textContent = label
    block.append(heading)
    return block
  }

  /**
   * Fetch the fiber's recent editorial events and render them into the
   * given container. Failures degrade quietly to an empty-state message —
   * history is informational, not load-bearing for the modal's primary
   * actions.
   */
  private async loadHistory(fiberId: string, container: HTMLElement): Promise<void> {
    try {
      const res = await fetch(
        `${this.apiBase}/kanban/fiber-history?fiberId=${encodeURIComponent(fiberId)}&limit=20`,
      )
      if (!res.ok) throw new Error(`${res.status}`)
      const data = (await res.json()) as {
        events: Array<{ occurredAt: string; actor: string; kind: string; summary: string }>
      }
      container.innerHTML = ''
      if (data.events.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'kbn-detail-history-empty'
        empty.textContent = 'No history yet.'
        container.append(empty)
        return
      }
      for (const ev of data.events) {
        container.append(this.renderHistoryEvent(ev))
      }
    } catch {
      container.innerHTML = ''
      const empty = document.createElement('div')
      empty.className = 'kbn-detail-history-empty'
      empty.textContent = 'History unavailable.'
      container.append(empty)
    }
  }

  /**
   * Render a single editorial event with a meta line (relative time + actor +
   * typed-kind pill if non-default) and a clamped summary that expands on
   * "Show more" click. Long events stay scannable; the user opts in to depth.
   */
  private renderHistoryEvent(ev: {
    occurredAt: string
    actor: string
    kind: string
    summary: string
  }): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-history-event'

    const meta = document.createElement('div')
    meta.className = 'kbn-detail-history-event-meta'

    const time = document.createElement('span')
    time.className = 'kbn-detail-history-event-time'
    time.textContent = formatRelative(ev.occurredAt)
    time.title = new Date(ev.occurredAt).toLocaleString()
    meta.append(time)

    if (ev.kind && ev.kind !== 'editorial') {
      const kindPill = document.createElement('span')
      kindPill.className = `kbn-detail-history-event-kind kbn-detail-history-event-kind-${ev.kind}`
      kindPill.textContent = ev.kind
      meta.append(kindPill)
    } else {
      const kindPill = document.createElement('span')
      kindPill.className = 'kbn-detail-history-event-kind kbn-detail-history-event-kind-editorial'
      kindPill.textContent = 'editorial'
      meta.append(kindPill)
    }

    const actor = document.createElement('span')
    actor.textContent = ev.actor
    meta.append(actor)

    wrap.append(meta)

    const summary = document.createElement('div')
    summary.className = 'kbn-detail-history-event-summary'
    summary.textContent = ev.summary || '(no summary)'
    wrap.append(summary)

    // Add a "Show more" toggle if the summary is long enough that the clamp
    // is likely to be hiding content. Use a character heuristic — pixel-
    // measuring overflow is complicated and the heuristic is good enough.
    if (ev.summary && ev.summary.length > 240) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'kbn-detail-history-event-toggle'
      toggle.textContent = 'Show more'
      toggle.addEventListener('click', (e) => {
        e.stopPropagation()
        const expanded = summary.classList.toggle('expanded')
        toggle.textContent = expanded ? 'Show less' : 'Show more'
      })
      wrap.append(toggle)
    }

    return wrap
  }

  private async loadAgents(
    select: HTMLSelectElement,
    currentAgent: string,
  ): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/shuttle/agents`)
      if (!res.ok) throw new Error(`${res.status}`)
      const data = (await res.json()) as { agents: Array<{ id: string; model?: string; default?: boolean }> }
      select.innerHTML = ''
      if (data.agents.length === 0) {
        const opt = document.createElement('option')
        opt.value = ''
        opt.textContent = 'No agents available'
        select.append(opt)
        return
      }
      for (const agent of data.agents) {
        const opt = document.createElement('option')
        opt.value = agent.id
        opt.textContent = agent.model ? `${agent.id} (${agent.model})` : agent.id
        if (agent.id === currentAgent) opt.selected = true
        select.append(opt)
      }
      // If no match, try to keep current agent as a custom entry.
      if (currentAgent && !data.agents.some(a => a.id === currentAgent)) {
        const opt = document.createElement('option')
        opt.value = currentAgent
        opt.textContent = `${currentAgent} (custom)`
        opt.selected = true
        select.prepend(opt)
      }
    } catch {
      select.innerHTML = '<option value="">Failed to load agents</option>'
    }
  }

  private async searchParents(
    q: string,
    excludeId: string,
    dropdown: HTMLElement,
    onSelect: (result: FiberSearchResult) => void,
  ): Promise<void> {
    try {
      const params = new URLSearchParams({ excludeId })
      if (q) params.set('q', q)
      const res = await fetch(`${this.apiBase}/kanban/fiber-search?${params}`)
      if (!res.ok) return
      const data = (await res.json()) as { fibers: FiberSearchResult[] }

      dropdown.innerHTML = ''
      if (data.fibers.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'kbn-detail-parent-option kbn-detail-parent-empty'
        empty.textContent = q ? 'No matches' : 'No fibers available'
        dropdown.append(empty)
        dropdown.style.display = ''
        return
      }

      for (const fiber of data.fibers) {
        const opt = document.createElement('button')
        opt.type = 'button'
        opt.className = 'kbn-detail-parent-option'
        opt.dataset.depth = String(fiber.depth)

        const nameSpan = document.createElement('span')
        nameSpan.className = 'kbn-detail-parent-option-name'
        nameSpan.textContent = fiber.name

        const idSpan = document.createElement('span')
        idSpan.className = 'kbn-detail-parent-option-id'
        idSpan.textContent = fiber.id

        opt.append(nameSpan, idSpan)
        opt.addEventListener('click', (e) => {
          e.stopPropagation()
          onSelect(fiber)
        })
        dropdown.append(opt)
      }
      dropdown.style.display = ''
    } catch {
      dropdown.innerHTML = '<div class="kbn-detail-parent-option kbn-detail-parent-empty">Search failed</div>'
      dropdown.style.display = ''
    }
  }

  private async save(
    fiberId: string,
    changes: {
      outcome?: string
      shuttleAgent?: string
      shuttleKind?: 'oneshot' | 'standing'
      shuttleSchedule?: string
      shuttleTz?: string
      parentId?: string | null
    },
    saveBtn: HTMLButtonElement,
    errorEl: HTMLElement,
  ): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/kanban/fiber-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId, ...changes }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `${res.status}` })) as { error?: string }
        throw new Error(err.error || `Save failed: ${res.status}`)
      }
      this.close()
      this.onSaved()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      saveBtn.disabled = false
      saveBtn.textContent = 'Save'
    }
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
