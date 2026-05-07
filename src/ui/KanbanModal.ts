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

import './KanbanModal.css'
import { renderMarkdown } from './utils.js'

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
  /**
   * `shuttle.review.state` — current review state for standing roles.
   * `'awaiting'` means the worker finished a run and is waiting for human
   * review. `'scheduled'` / `'accepted'` means the role is dispatch-eligible.
   * Absent for oneshot fibers and fibers with no shuttle block.
   *
   * Used by `runRequeue` to decide whether to run `shuttle-ctl accept` (via
   * POST /kanban/transition) before forcing a dispatch: the daemon's
   * force_dispatchable_standing_role? rejects `awaiting` state.
   */
  shuttleReviewState?: 'scheduled' | 'awaiting' | 'accepted'
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
    window.addEventListener('resize', this.handleResize)
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
    window.removeEventListener('resize', this.handleResize)
    if (this.resizeRaf !== null) {
      window.cancelAnimationFrame(this.resizeRaf)
      this.resizeRaf = null
    }
    this.stopPolling()
    this.container.remove()
    this.teardownState()
  }

  private resizeRaf: number | null = null
  private readonly handleResize = (): void => {
    // Debounce via RAF — resize fires rapidly during a drag.
    if (this.resizeRaf !== null) return
    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = null
      this.expandOutcomesToFillSpace()
    })
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
    // Use the server's placement from the last response — that's the source
    // of truth for which column the card is in. Re-deriving from card fields
    // here is a footgun: column classification depends on `shuttle.enabled`,
    // `idea` tag, `tempered`, standing-role review state, etc. — anything
    // the local rule misses (or drifts from the server) silently no-ops the
    // drag with a snap-back.
    const fromKind = findCardColumn(this.lastResponse, card.id)
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
      // Skip re-render when the response is semantically unchanged —
      // every 15-second poll otherwise tears down ~50 cards × ~30 nodes
      // each just to rebuild them identically. Hash the meaningful
      // payload (columns + totals); `generatedAt` and per-origin
      // staleness flicker each poll even on no-op refreshes.
      const sig = this.computeResponseSignature(data)
      const wasFirstRender = this.lastResponse === null
      this.lastResponse = data
      if (this.statusEl) this.statusEl.textContent = ''
      if (!wasFirstRender && sig === this.lastResponseSig) return
      this.lastResponseSig = sig
      this.render(data)
    } catch (err: unknown) {
      if (token !== this.inflightFetchToken) return
      const msg = (err as { message?: string })?.message ?? String(err)
      this.renderError(msg)
    }
  }

  private computeResponseSignature(data: KanbanResponse): string {
    // JSON.stringify on { columns, totals, temperedTotal } is sufficient —
    // structural equality of the rendered surface. Skips `generatedAt`
    // (changes every poll) and `staleness` (often flickers on remote
    // origins). If staleness rendering becomes load-bearing later, fold
    // in a stable subset of those fields here.
    return JSON.stringify({
      c: data.columns,
      t: data.totals,
      tt: data.temperedTotal,
    })
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
    // Expand line-clamp on outcomes in columns with spare vertical space.
    // Two RAFs: the first lets layout settle so scrollHeight reflects the
    // initial 4-line clamp; the second applies the bump and we let the
    // browser re-layout from there.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => this.expandOutcomesToFillSpace())
    })
    this.lastResponse = data
  }

  /**
   * Post-render pass that bumps `--card-line-clamp` globally — every
   * card across every column gets the same clamp value, computed from
   * the most-constrained column. The default 4-line clamp is the floor;
   * if every column has spare vertical space at clamp 4, we extend the
   * clamp by however many lines the tightest column can afford.
   *
   * Why global, not per-column: visual rhythm. A card in In Flight that
   * shows 12 lines of outcome next to a card in Drafts that shows 4
   * reads as inconsistent. Picking the min across columns means cards
   * look the same height everywhere, at the cost of leaving spare
   * space at the bottom of the less-constrained columns. The user
   * prefers undershoot to overshoot, and uniformity to maximal fill.
   *
   * Algorithm:
   *   1. Reset --card-line-clamp on all cards (the variable is set on
   *      .kbn-body so it cascades; clearing per-card overrides too).
   *   2. For each non-empty column, measure spare = clientHeight -
   *      scrollHeight at clamp 4. Compute affordable = floor(spare /
   *      (N_cards × line_height)). Negative if the column already
   *      overflows.
   *   3. Take the min of affordable across columns. If that's > 0,
   *      set --card-line-clamp on .kbn-body to 4 + min. Cards inherit.
   */
  private expandOutcomesToFillSpace(): void {
    if (!this.body) return
    // Outcome font-size × line-height = 12.5 × 1.4 = 17.5px per line.
    const lineHeight = 17.5
    // Cap the extension so an overall sparse layout doesn't grow cards
    // into multi-screen-height monsters. 16 lines accommodates most long
    // outcomes without dominating the column.
    const maxExtraLines = 12

    // Reset cascade root so the next measurement reflects the 4-line floor,
    // not whatever was set last time. Per-card overrides aren't used here
    // (we set the variable on .kbn-body) but clear them defensively so a
    // stale value from the per-column implementation doesn't bias things.
    this.body.style.removeProperty('--card-line-clamp')
    for (const card of this.body.querySelectorAll<HTMLElement>('.kbn-card')) {
      card.style.removeProperty('--card-line-clamp')
    }

    let minAffordable = Infinity
    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col')) {
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      if (!list) continue
      const cards = list.querySelectorAll<HTMLElement>('.kbn-card')
      if (cards.length === 0) continue

      const spare = list.clientHeight - list.scrollHeight
      // Negative when the column already overflows at 4 lines: that
      // column governs the global clamp DOWN, but we don't shrink below
      // the 4-line floor; treat overflowing columns as 0-affordable.
      const affordable = Math.max(0, Math.floor(spare / (cards.length * lineHeight)))
      if (affordable < minAffordable) minAffordable = affordable
    }

    if (!Number.isFinite(minAffordable) || minAffordable <= 0) return

    const newClamp = 4 + Math.min(minAffordable, maxExtraLines)
    this.body.style.setProperty('--card-line-clamp', String(newClamp))
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

    // Header row: title (opens detail modal) + status pill.
    // Drag handle retired — the whole card is the drag surface. Title is
    // the only explicit click target; clicks elsewhere on the card body
    // also open the detail modal (see card-level click handler below).
    // Vellum is reachable via the modal's "→ vellum" affordance.
    const headerRow = document.createElement('div')
    headerRow.className = 'kbn-card-header'

    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'kbn-card-name'
    name.setAttribute('aria-label', `Open ${card.name} details`)
    name.title = 'Click to open details'
    name.textContent = card.name
    name.addEventListener('click', (e) => {
      e.stopPropagation()
      this.detailModal?.open(card, this.cityScope?.cityId, kind)
    })

    const pill = document.createElement('span')
    pill.className = `kbn-pill kbn-pill-${this.pillKind(card)}`
    pill.textContent = this.pillLabel(card)

    headerRow.append(name, pill)
    el.append(headerRow)

    // Fiber id (small, breadcrumb-ish). Plain text — no click target so
    // the rest of the card body funnels cleanly to the detail modal.
    const idEl = document.createElement('div')
    idEl.className = 'kbn-card-id'
    idEl.textContent = card.id
    el.append(idEl)

    // Outcome (truncated; CSS line-clamp)
    if (card.outcome) {
      const outcome = document.createElement('div')
      outcome.className = 'kbn-card-outcome'
      outcome.innerHTML = renderMarkdown(card.outcome)
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
    if (kind === 'awaitingReview' && !isStale) {
      // Inline temper/compost buttons sit left of the timestamp.
      const reviewMetaActions = document.createElement('div')
      reviewMetaActions.className = 'kbn-card-review-meta-actions'

      const temperMetaBtn = document.createElement('button')
      temperMetaBtn.type = 'button'
      temperMetaBtn.className = 'kbn-action kbn-action-tempered kbn-review-meta-btn'
      temperMetaBtn.textContent = 'Temper'
      temperMetaBtn.setAttribute('aria-label', `Temper fiber: ${card.name}`)
      temperMetaBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.transition(card, 'tempered')
      })

      const compostMetaBtn = document.createElement('button')
      compostMetaBtn.type = 'button'
      compostMetaBtn.className = 'kbn-action kbn-action-drafts kbn-review-meta-btn'
      compostMetaBtn.textContent = 'Compost'
      compostMetaBtn.setAttribute('aria-label', `Compost fiber: ${card.name}`)
      compostMetaBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.transition(card, 'composted')
      })

      reviewMetaActions.append(temperMetaBtn, compostMetaBtn)
      // Insert before date so order is: tags … [Temper][Compost] [date]
      meta.insertBefore(reviewMetaActions, date)
    }
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

    // The directive textbox + Requeue/Resume buttons retired from the
    // grid card on 2026-05-08; they live in the detail modal now (one
    // canonical surface for "next dispatch"). Inline Temper/Compost
    // remain in the meta row for the awaiting-review one-click path.

    // Click outside any button → open fiber detail modal.
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a, button, textarea')) return
      this.detailModal?.open(card, this.cityScope?.cityId, kind)
    })

    return el
  }

  /** Stash the latest response so drop handlers can resolve cards by id. */
  private lastResponse: KanbanResponse | null = null
  /**
   * Signature of the last-rendered response (columns + totals only). Lets
   * fetchAndRender skip identical-payload re-renders — the 15-second poll
   * fires even when nothing changed and rebuilding the column DOM is the
   * dominant frontend cost.
   */
  private lastResponseSig: string | null = null

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
export class FiberDetailModal {
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

  /**
   * @param card the card the user clicked
   * @param scopeCityId  the cityId the parent kanban view is scoped to
   *   (`undefined` for the global kanban). Drives URL routing for the
   *   modal's three endpoints (history, search, patch). Card ids are
   *   *project-relative* under city scope and *loom-relative* under
   *   global scope, so the request must reach the same kanbanApi
   *   that produced the card — `card.cityId` is the wrong axis here
   *   (a global card carries the cityId for vellum nav, but its id is
   *   loom-relative and must NOT route through the city-scoped API).
   * @param columnKind  the column the card lives in — used to gate the
   *   "Dispatch now" button (visible only for inFlight, non-running cards).
   */
  open(card: KanbanCard, scopeCityId?: string | null, _columnKind?: ColumnKind): void {
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

    // Title is read-only here. The id slug below is the canonical
    // click-to-vellum target — slugs are the recognisable fiber
    // identifiers across the app, so they're consistently the link.
    const title = document.createElement('div')
    title.className = 'kbn-detail-title'
    title.textContent = card.name

    const openInVellum = (e: Event) => {
      e.stopPropagation()
      this.close()
      this.onOpenFiber(card)
    }

    const pill = document.createElement('span')
    pill.className = `kbn-pill kbn-pill-${card.status === 'closed' ? 'closed' : card.status === 'active' ? 'active' : 'open'}`
    pill.textContent = card.status || 'open'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'kbn-detail-close'
    closeBtn.setAttribute('aria-label', 'Close fiber detail')
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', () => this.close())

    // ── ID breadcrumb (stacked under the title) ───────────────────────────
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

    // Title + id stacked on the left; pill + close on the right of the
    // header. The stack flexes so wrapping titles don't displace the pill.
    const titleStack = document.createElement('div')
    titleStack.className = 'kbn-detail-title-stack'
    titleStack.append(title, idEl)

    header.append(titleStack, pill, closeBtn)

    // ── Outcome ──────────────────────────────────────────────────────────────
    // Read-only rendered markdown. Outcomes carry tables, links, code blocks,
    // image embeds — flat <textarea> rendering swallowed the structure and
    // made even short outcomes hard to scan. Edits go through vellum (the
    // open-in-vellum action on the modal); the kanban detail view is for
    // skimming current state, not authoring.
    const outcomeSec = this.buildSection('Outcome')
    const outcomeView = document.createElement('div')
    outcomeView.className = 'kbn-detail-outcome-view'
    if (card.outcome && card.outcome.trim().length > 0) {
      outcomeView.innerHTML = renderMarkdown(card.outcome)
    } else {
      outcomeView.classList.add('kbn-detail-outcome-empty')
      outcomeView.textContent = 'No outcome yet.'
    }
    // Don't let clicks inside the outcome bubble up to the modal's drag/close
    // affordances — same swallow the textarea used to do.
    outcomeView.addEventListener('mousedown', (e) => e.stopPropagation())
    outcomeView.addEventListener('click', (e) => e.stopPropagation())
    outcomeSec.append(outcomeView)

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
    // Routing scope: parent kanban's view scope (NOT card.cityId).
    // See open()'s docstring for why these differ on the global kanban.
    const scope = scopeCityId ?? undefined
    void this.loadHistory(card.id, scope, historyList)

    // ── Next dispatch (message + mode + action buttons) ──────────────────────
    // One canonical surface for "what happens when this fiber dispatches next."
    // The message textarea is the optional payload; the Autonomous|Interactive
    // toggle determines whether the worker exits at the end of its initial
    // task (autonomous, default) or stays alive for a human to attach
    // (interactive — shuttle injects a "don't kill PPID" prelude).
    const actionsSec = this.buildSection('Next dispatch')
    const actionsErr = document.createElement('div')
    actionsErr.className = 'kbn-detail-error'
    actionsErr.style.display = 'none'

    const messageTa = document.createElement('textarea')
    messageTa.className = 'kbn-detail-directive'
    messageTa.placeholder = 'Message for the next worker (optional)…'
    messageTa.rows = 3
    messageTa.setAttribute('aria-label', 'Message for next worker')
    messageTa.addEventListener('mousedown', (e) => e.stopPropagation())
    messageTa.addEventListener('click', (e) => e.stopPropagation())

    // Autonomous | Interactive segmented control. Default: Autonomous (the
    // current behavior — worker runs to completion and exits via kill PPID).
    // Interactive tells shuttle to inject a prelude saying "a human will
    // attach; do not kill PPID after the initial task." Both Resubmit and
    // Resume read the toggle.
    const modeRow = document.createElement('div')
    modeRow.className = 'kbn-detail-mode-row'
    modeRow.setAttribute('role', 'radiogroup')
    modeRow.setAttribute('aria-label', 'Dispatch mode')

    const interactiveState = { value: false }
    const buildModeBtn = (label: string, isInteractive: boolean, title: string) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-detail-mode-btn'
      btn.textContent = label
      btn.title = title
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-checked', String(interactiveState.value === isInteractive))
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        interactiveState.value = isInteractive
        for (const el of modeRow.querySelectorAll<HTMLButtonElement>('.kbn-detail-mode-btn')) {
          const onIfInteractive = el.dataset.mode === 'interactive'
          el.setAttribute('aria-checked', String(interactiveState.value === onIfInteractive))
        }
      })
      btn.dataset.mode = isInteractive ? 'interactive' : 'autonomous'
      return btn
    }
    const autoBtn = buildModeBtn(
      'Autonomous',
      false,
      'Worker runs to completion and exits (kill PPID at the end).',
    )
    autoBtn.setAttribute('aria-checked', 'true')
    const interactiveBtn = buildModeBtn(
      'Interactive',
      true,
      "Worker stays alive after its initial task so you can attach and continue the conversation. Shuttle injects a 'don't kill PPID' prelude.",
    )
    modeRow.append(autoBtn, interactiveBtn)

    const actionsRow = document.createElement('div')
    actionsRow.className = 'kbn-detail-actions-row'

    const requeueBtn = this.buildActionBtn('Resubmit ▸', 'primary')
    requeueBtn.title = 'Dispatch a fresh worker (with message + mode if set)'

    const hasSession = !!card.sessionId
    const resumeBtn = this.buildActionBtn('Resume ▸', 'primary')
    resumeBtn.disabled = !hasSession
    resumeBtn.title = hasSession
      ? 'Resume previous worker session (with message + mode if set)'
      : 'No prior session stored — dispatch a fresh worker first'

    const temperBtn = this.buildActionBtn('Temper', 'tempered')
    temperBtn.title = 'Close as tempered (human-accepted)'

    const compostBtn = this.buildActionBtn('Compost', 'composted')
    compostBtn.title = 'Close as composted (human-rejected)'

    actionsRow.append(requeueBtn, resumeBtn, temperBtn, compostBtn)

    requeueBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const message = messageTa.value.trim()
      const interactive = interactiveState.value
      const needsAcceptFirst =
        card.shuttleKind === 'standing' && card.shuttleReviewState === 'awaiting'
      if (message === '' && !needsAcceptFirst && !interactive) {
        // Empty message + autonomous + already dispatch-eligible -> immediate
        // dispatch, no review-comment needed.
        void this.runDispatchNow(card, requeueBtn, actionsErr, interactive)
      } else {
        // Non-empty message, interactive mode (we want it persisted on the
        // review-comment so the worker reads it), or standing role in
        // awaiting state (needs shuttle-ctl accept transition before
        // force-dispatch) -> runRequeue, which handles the review-comment +
        // optional transition + dispatch.
        void this.runRequeue(card, message, 'fresh', scope, requeueBtn, actionsErr, interactive)
      }
    })
    resumeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!hasSession) return
      void this.runRequeue(
        card,
        messageTa.value.trim(),
        'previous',
        scope,
        resumeBtn,
        actionsErr,
        interactiveState.value,
      )
    })
    temperBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.runTransition(card, 'tempered', scope, temperBtn, actionsErr)
    })
    compostBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.runTransition(card, 'composted', scope, compostBtn, actionsErr)
    })

    actionsSec.append(messageTa, modeRow, actionsRow, actionsErr)

    // ── Tags ────────────────────────────────────────────────────────────────
    // Chip editor matching the kanban grid card's inline tag editor. Adding
    // a tag commits to /kanban/tags immediately on Enter; removing via the ×
    // chip button does the same. No Save/Cancel — chips reflect server
    // state, edits are atomic.
    const tagsSec = this.buildSection('Tags')
    const tagsErr = document.createElement('div')
    tagsErr.className = 'kbn-detail-error'
    tagsErr.style.display = 'none'

    const tagsRow = document.createElement('div')
    tagsRow.className = 'kbn-detail-tags-row'
    const tagsState: { current: string[] } = {
      current: (card.tags ?? []).filter((t) => t !== 'constitution'),
    }
    const tagInput = document.createElement('input')
    tagInput.type = 'text'
    tagInput.className = 'kbn-detail-tag-input'
    tagInput.placeholder = 'add tag…'
    tagInput.setAttribute('aria-label', 'Add a tag')
    tagInput.addEventListener('mousedown', (e) => e.stopPropagation())
    tagInput.addEventListener('click', (e) => e.stopPropagation())
    tagInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const val = tagInput.value.trim()
      if (!val || tagsState.current.includes(val)) {
        tagInput.value = ''
        return
      }
      const next = [...tagsState.current, val]
      void this.runTagsSave(card, next, scope, tagsState, tagsRow, tagInput, tagsErr)
    })

    const renderTags = (): void => {
      // Remove existing chip nodes (everything except the input).
      Array.from(tagsRow.querySelectorAll('.kbn-detail-tag-chip')).forEach((n) => n.remove())
      for (const t of tagsState.current) {
        const chip = document.createElement('span')
        chip.className = 'kbn-detail-tag-chip'
        const lbl = document.createElement('span')
        lbl.textContent = t
        const rm = document.createElement('button')
        rm.type = 'button'
        rm.className = 'kbn-detail-tag-remove'
        rm.textContent = '×'
        rm.setAttribute('aria-label', `Remove tag ${t}`)
        rm.addEventListener('click', (e) => {
          e.stopPropagation()
          const next = tagsState.current.filter((x) => x !== t)
          void this.runTagsSave(card, next, scope, tagsState, tagsRow, tagInput, tagsErr)
        })
        chip.append(lbl, rm)
        tagsRow.insertBefore(chip, tagInput)
      }
    }
    tagsRow.append(tagInput)
    renderTags()
    // Cache the renderer on the row so runTagsSave can re-render after success.
    ;(tagsRow as unknown as { _renderTags: () => void })._renderTags = renderTags
    tagsSec.append(tagsRow, tagsErr)

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

    const dispatchSec = this.buildSection('Worker')

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
    const parentSec = this.buildSection('Parent fiber')

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
    parentInput.setAttribute('role', 'combobox')
    parentInput.setAttribute('aria-expanded', 'false')
    parentInput.setAttribute('aria-haspopup', 'listbox')
    // Stop card-level clicks propagating (there's no card here, but be defensive).
    parentInput.addEventListener('mousedown', (e) => e.stopPropagation())
    parentInput.addEventListener('click', (e) => e.stopPropagation())

    const parentDropdown = document.createElement('div')
    parentDropdown.className = 'kbn-detail-parent-dropdown'
    parentDropdown.style.display = 'none'
    parentDropdown.setAttribute('role', 'listbox')

    // Shared pick-handler referenced by both the search callback and
    // keyboard Enter on a focused option.
    const onPickParent = (result: FiberSearchResult) => {
      selectedParentId = result.id
      currentParentEl.textContent = `↳ ${result.id} (pending)`
      currentParentEl.classList.add('kbn-detail-pending-change')
      parentInput.value = result.name
      parentInput.setAttribute('aria-expanded', 'false')
      parentDropdown.style.display = 'none'
    }

    // Trigger a search (with the current input value) and open the dropdown.
    // Always called on focus so the dropdown is reactive — shows matching
    // options immediately regardless of whether the input is empty or has a
    // previously-selected value.
    const openDropdown = () => {
      void this.searchParents(
        parentInput.value.trim(),
        card.id,
        scope,
        parentDropdown,
        onPickParent,
      ).then(() => {
        if (parentDropdown.style.display !== 'none') {
          parentInput.setAttribute('aria-expanded', 'true')
        }
      })
    }

    // Search on input with debounce.
    parentInput.addEventListener('input', () => {
      if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
      this.searchDebounce = window.setTimeout(() => openDropdown(), 200)
    })

    // Reactive: show options immediately on focus regardless of current value.
    parentInput.addEventListener('focus', () => openDropdown())

    // Keyboard: ArrowDown moves focus into the dropdown; Escape closes it.
    parentInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        const first = parentDropdown.querySelector<HTMLElement>('button')
        if (first) { e.preventDefault(); first.focus() }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        parentDropdown.style.display = 'none'
        parentInput.setAttribute('aria-expanded', 'false')
      }
    })

    // Keyboard navigation inside the dropdown — handles ArrowUp/Down/Enter/Escape
    // on option buttons without requiring individual listeners per option.
    parentDropdown.addEventListener('keydown', (e) => {
      const opts = Array.from(
        parentDropdown.querySelectorAll<HTMLElement>('button:not(:disabled)'),
      )
      const idx = opts.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown' && idx < opts.length - 1) {
        e.preventDefault()
        opts[idx + 1].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx > 0) opts[idx - 1].focus()
        else parentInput.focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        // Focus the input first — calling focus() before setting display:none
        // avoids the browser/jsdom behaviour where hiding a container that
        // holds the focused element drops focus to <body> before we can
        // redirect it to parentInput.
        parentInput.focus()
        parentDropdown.style.display = 'none'
        parentInput.setAttribute('aria-expanded', 'false')
      }
    })

    // Close dropdown when focus leaves the entire component (input + dropdown).
    // Using focusout on the wrapper — fires for any child blur — so the
    // dropdown stays open while focus moves between the input and the options.
    parentSearchWrap.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!parentSearchWrap.contains(document.activeElement)) {
          parentDropdown.style.display = 'none'
          parentInput.setAttribute('aria-expanded', 'false')
        }
      }, 150)
    })

    parentSearchWrap.append(parentInput, parentDropdown)
    parentSec.append(currentParentEl, parentSearchWrap)

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

    const errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.style.display = 'none'

    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'kbn-detail-save-btn'
    saveBtn.textContent = 'Save'
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const changes: {
        shuttleAgent?: string
        shuttleKind?: 'oneshot' | 'standing'
        shuttleSchedule?: string
        shuttleTz?: string
        parentId?: string | null
      } = {}

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

      void this.save(card.id, scope, changes, saveBtn, errorEl)
    })

    footer.append(vellumBtn, errorEl, saveBtn)

    // ── Assemble ─────────────────────────────────────────────────────────────
    // Two columns side by side on parchment:
    //   left  → outcome (prose, scrolls internally for long outcomes)
    //   right → dispatch + parent controls (top), then history (scrolls)
    // A vertical hairline divides the columns; a horizontal hairline in the
    // right column separates controls from history.
    const body = document.createElement('div')
    body.className = 'kbn-detail-body'

    const leftCol = document.createElement('div')
    leftCol.className = 'kbn-detail-col kbn-detail-col-left'
    leftCol.append(outcomeSec, this.buildRule(), historySec)

    const rightCol = document.createElement('div')
    rightCol.className = 'kbn-detail-col kbn-detail-col-right'
    rightCol.append(
      actionsSec,
      tagsSec,
      this.buildRule(),
      dispatchSec,
      parentSec,
    )

    body.append(leftCol, rightCol)

    dialog.append(header, body, footer)
    overlay.append(dialog)
    document.body.append(overlay)
    this.overlay = overlay

    // Escape to close the modal. When the parent-fiber dropdown is open and
    // focus is inside it, yield to the dropdown's own keydown listener so it
    // can close just the dropdown (not the whole modal). The dropdown's
    // bubble-phase listener runs after this capture-phase handler returns.
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Let the dropdown handle its own Escape: if focus is inside the
      // parent-fiber dropdown, return without closing the modal so the
      // dropdown's bubble-phase listener can close just the dropdown.
      if (document.activeElement?.closest('.kbn-detail-parent-dropdown')) return
      this.close()
    }
    document.addEventListener('keydown', this.escapeHandler, true)

    // Park the outcome panel scrolled to the top after mount — for
    // multi-paragraph outcomes the user lands on the opening line rather
    // than wherever the browser's default focus would have wandered.
    window.requestAnimationFrame(() => {
      outcomeView.scrollTop = 0
    })
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
    sec.dataset.section = label.toLowerCase()
    const heading = document.createElement('div')
    heading.className = 'kbn-detail-section-heading'
    heading.textContent = label
    sec.append(heading)
    return sec
  }

  /**
   * Hairline printer's rule used to separate sections in the body. Pure
   * presentational element — no semantic role.
   */
  private buildRule(): HTMLElement {
    const rule = document.createElement('div')
    rule.className = 'kbn-detail-rule'
    rule.setAttribute('aria-hidden', 'true')
    return rule
  }

  /**
   * Build a button for the action cluster. Variants tint the button to
   * match the kanban grid's `kbn-action-*` palette (gold for primary
   * requeue/resume, teal for tempered, muted gray for composted).
   */
  private buildActionBtn(
    label: string,
    variant: 'primary' | 'tempered' | 'composted' | 'dispatch',
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `kbn-detail-action-btn kbn-detail-action-${variant}`
    btn.textContent = label
    return btn
  }

  /** URL helper for /kanban/transition with cityScope. */
  private transitionUrl(cityId: string | undefined): string {
    return cityId
      ? `${this.apiBase}/kanban/transition?cityId=${encodeURIComponent(cityId)}`
      : `${this.apiBase}/kanban/transition`
  }

  /** URL helper for /kanban/review-comment with cityScope. */
  private reviewCommentUrl(cityId: string | undefined): string {
    return cityId
      ? `${this.apiBase}/kanban/review-comment?cityId=${encodeURIComponent(cityId)}`
      : `${this.apiBase}/kanban/review-comment`
  }

  /** URL helper for /kanban/tags with cityScope. */
  private tagsUrl(cityId: string | undefined): string {
    return cityId
      ? `${this.apiBase}/kanban/tags?cityId=${encodeURIComponent(cityId)}`
      : `${this.apiBase}/kanban/tags`
  }

  /**
   * Two-step requeue: record a directive event (review-comment), then wake
   * the worker. One-shot fibers wake by transitioning to inFlight; standing
   * roles wake through immediate daemon dispatch because their next_due_at may
   * be in the future even while the card already sits in the in-flight column.
   *
   * `interactive=true` is persisted on the review-comment so the dispatcher
   * can inject a "don't kill PPID; a human will attach" prelude when the
   * worker spawns. The same flag is forwarded to runDispatchNow for standing
   * roles, which dispatch directly via /api/v1/dispatch rather than the
   * transition-then-poll path.
   */
  private async runRequeue(
    card: KanbanCard,
    directive: string,
    mode: 'fresh' | 'previous',
    cityId: string | undefined,
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
    interactive: boolean = false,
  ): Promise<void> {
    const original = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = mode === 'fresh' ? 'Resubmitting…' : 'Resuming…'
    errorEl.style.display = 'none'
    try {
      const commentRes = await fetch(this.reviewCommentUrl(cityId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, directive, resumeMode: mode, interactive }),
      })
      if (!commentRes.ok) {
        const e = (await commentRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `review-comment ${commentRes.status}`)
      }
      if (card.shuttleKind === 'standing') {
        // Standing roles in awaiting review state need shuttle-ctl accept to
        // transition review.state → scheduled before the daemon will accept a
        // force dispatch. The daemon's force_dispatchable_standing_role? only
        // passes for review.state ∈ {scheduled, accepted, due} — it rejects
        // awaiting. The kanban transition with target=inFlight detects
        // standing+awaiting and routes to `shuttle-ctl accept`, which advances
        // next_due_at and puts the fiber in the scheduled state the daemon
        // expects. Standing roles not in awaiting state (already scheduled/due)
        // are force-dispatchable directly.
        if (card.shuttleReviewState === 'awaiting') {
          const transRes = await fetch(this.transitionUrl(cityId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fiberId: card.id, target: 'inFlight' }),
          })
          if (!transRes.ok) {
            const e = (await transRes.json().catch(() => ({}))) as { error?: string }
            throw new Error(e.error || `transition ${transRes.status}`)
          }
        }
        await this.runDispatchNow(card, btn, errorEl, interactive)
        return
      }
      const transRes = await fetch(this.transitionUrl(cityId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, target: 'inFlight' }),
      })
      if (!transRes.ok) {
        const e = (await transRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `transition ${transRes.status}`)
      }
      this.close()
      this.onSaved()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      btn.disabled = false
      btn.textContent = original
    }
  }

  /**
   * Single-step transition (no directive). Used for Temper / Compost
   * buttons — those are terminal moves where a directive is moot.
   */
  private async runTransition(
    card: KanbanCard,
    target: string,
    cityId: string | undefined,
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
  ): Promise<void> {
    const original = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = '…'
    errorEl.style.display = 'none'
    try {
      const res = await fetch(this.transitionUrl(cityId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, target }),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `transition ${res.status}`)
      }
      this.close()
      this.onSaved()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      btn.disabled = false
      btn.textContent = original
    }
  }

  /**
   * Trigger immediate dispatch via the Shuttle daemon's
   * POST /api/v1/dispatch endpoint (port 4000). Bypasses the poller's
   * 15-second poll cycle so the fiber starts right now.
   *
   * Response contract (mirrors DispatchController):
   *   200  dispatched:true        → success; close modal, refresh kanban.
   *   409  reason:already_running → "Already running" on button; neutral info.
   *   422  reason:not_eligible    → not currently due, disabled, or closed;
   *                                 show human-readable explanation.
   *   500  reason:<text>          → daemon-side error; surface the message.
   *   network / CORS              → fetch throws TypeError; show "couldn't
   *                                 reach daemon" rather than a generic browser
   *                                 error string like "Load failed".
   */
  private async runDispatchNow(
    card: KanbanCard,
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
    interactive: boolean = false,
  ): Promise<void> {
    const original = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = 'Dispatching…'
    errorEl.style.display = 'none'

    // Derive the shuttle daemon URL (port 4000) from the portolan API base
    // (port 4004), keeping the same hostname. Falls back to 127.0.0.1 if
    // the API base hostname can't be parsed.
    let shuttleBase: string
    try {
      const u = new URL(this.apiBase)
      shuttleBase = `${u.protocol}//${u.hostname}:4000`
    } catch {
      shuttleBase = 'http://127.0.0.1:4000'
    }

    // Distinguish network failures (fetch never completed) from HTTP errors
    // (server responded). A TypeError from fetch means no response arrived —
    // CORS block, daemon not running, or network partition.
    let res: Response
    try {
      res = await fetch(`${shuttleBase}/api/v1/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiber_id: card.id,
          ...(card.shuttleKind === 'standing' ? { force: true } : {}),
          ...(interactive ? { interactive: true } : {}),
        }),
      })
    } catch (err: unknown) {
      // Network / CORS / daemon-unreachable path.
      const detail = (err as { message?: string })?.message ?? String(err)
      this.showDispatchError(
        errorEl,
        btn,
        original,
        `Couldn't reach the Shuttle daemon (${shuttleBase}). Is it running? ${detail}`,
      )
      return
    }

    const body = await res.json().catch(() => ({})) as {
      dispatched?: boolean
      reason?: string
      tmux_session?: string
    }

    if (res.status === 409) {
      // Already running — update button to reflect state neutrally.
      btn.textContent = 'Already running'
      btn.disabled = true
      errorEl.textContent = 'A worker is already running for this fiber.'
      errorEl.style.display = ''
      return
    }

    if (res.status === 422) {
      // not_eligible: the daemon knows why — not yet due, disabled, or closed.
      const humanReason = dispatchIneligibleReason(body.reason)
      this.showDispatchError(errorEl, btn, original, humanReason)
      return
    }

    if (!res.ok) {
      // Daemon-side error (500 etc.) — surface whatever reason the body carries.
      const msg = body.reason ?? `Dispatch failed (${res.status})`
      this.showDispatchError(errorEl, btn, original, msg)
      return
    }

    // 200 success — close the modal and refresh the kanban board.
    this.close()
    this.onSaved()
  }

  private showDispatchError(
    errorEl: HTMLElement,
    btn: HTMLButtonElement,
    originalBtnText: string,
    message: string,
  ): void {
    errorEl.textContent = message
    errorEl.style.display = ''
    btn.disabled = false
    btn.textContent = originalBtnText
  }

  /**
   * Persist the new tag set via /kanban/tags and re-render the chip row
   * on success. Stays open — tags are an inline edit, not a final
   * gesture, so the modal doesn't close.
   */
  private async runTagsSave(
    card: KanbanCard,
    tags: string[],
    cityId: string | undefined,
    state: { current: string[] },
    _row: HTMLElement,
    input: HTMLInputElement,
    errorEl: HTMLElement,
  ): Promise<void> {
    errorEl.style.display = 'none'
    // Tags sent to the server include `constitution` if the fiber had
    // it (the chip editor filters constitution out of the visible chips
    // because it's not user-editable, but the server expects the full set).
    const fullTags = (card.tags ?? []).includes('constitution')
      ? ['constitution', ...tags.filter((t) => t !== 'constitution')]
      : tags
    try {
      const res = await fetch(this.tagsUrl(cityId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, tags: fullTags }),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `tags ${res.status}`)
      }
      // Mirror server state into local; clear input; re-render chips.
      state.current = tags.filter((t) => t !== 'constitution')
      // Update the card object so future reads of card.tags see the new set
      // (e.g. if other parts of the modal read it later).
      card.tags = fullTags
      input.value = ''
      const ren = (_row as unknown as { _renderTags?: () => void })._renderTags
      if (typeof ren === 'function') ren()
      // Inform parent kanban so the grid card refreshes with the new tags.
      this.onSaved()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
    }
  }

  /**
   * Fetch the fiber's recent editorial events and render them into the
   * given container. Failures degrade quietly to an empty-state message —
   * history is informational, not load-bearing for the modal's primary
   * actions.
   */
  private async loadHistory(
    fiberId: string,
    cityId: string | undefined,
    container: HTMLElement,
    attempt = 0,
  ): Promise<void> {
    try {
      // City-scoped kanban cards carry project-relative ids; threading
      // cityId routes the request to the same kanbanApi that produced the
      // card so the merged collection finds the fiber by its local id.
      // Without this, history loaded fine on the global kanban but came
      // back empty on city-scoped views.
      const params = new URLSearchParams({ fiberId, limit: '20' })
      if (cityId) params.set('cityId', cityId)
      const res = await fetch(
        `${this.apiBase}/kanban/fiber-history?${params}`,
      )
      if (!res.ok) throw new Error(`${res.status}`)
      const data = (await res.json()) as {
        events: Array<{ occurredAt: string; actor: string; kind: string; summary: string }>
        busy?: boolean
      }
      // Felt's SQLite index is busy this poll (another writer holds the
      // lock). Empty events here doesn't mean "no history" — it means
      // "couldn't read this time." Show a transient state and retry a
      // couple of times before giving up. Cap attempts so a stuck-busy
      // index doesn't wedge the modal.
      if (data.busy && attempt < 3) {
        container.innerHTML = ''
        const refreshing = document.createElement('div')
        refreshing.className = 'kbn-detail-history-empty'
        refreshing.textContent = 'Refreshing…'
        container.append(refreshing)
        const backoff = 250 * (attempt + 1)
        window.setTimeout(() => {
          void this.loadHistory(fiberId, cityId, container, attempt + 1)
        }, backoff)
        return
      }
      container.innerHTML = ''
      // Drop summary-less events — the time/actor/kind metadata alone
      // doesn't tell the reader anything they can act on, and rows of
      // "(no summary)" just add visual noise. The underlying events
      // still exist in the felt index for tooling that wants them; the
      // modal is for human reading.
      const events = data.events.filter((ev) => (ev.summary ?? '').trim().length > 0)
      if (events.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'kbn-detail-history-empty'
        empty.textContent = data.busy
          ? 'History unavailable — felt index is busy. Retry shortly.'
          : 'No history yet.'
        container.append(empty)
        return
      }
      for (const ev of events) {
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
    cityId: string | undefined,
    dropdown: HTMLElement,
    onSelect: (result: FiberSearchResult) => void,
  ): Promise<void> {
    try {
      const params = new URLSearchParams({ excludeId })
      if (q) params.set('q', q)
      // Same scope-routing as loadHistory: a city-scoped kanban needs
      // fiber-search to consult the same merged collection that owns the
      // card, otherwise excludeId (a project-relative id) doesn't match
      // any fiber and the project-prefix derivation falls apart.
      if (cityId) params.set('cityId', cityId)
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
    cityId: string | undefined,
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
      // cityId rides the URL because resolveKanbanApi reads from
      // url.searchParams (not the body). Without it, fiber-patch on a
      // city-scoped card lands on the global kanbanApi and fails to find
      // the project-relative fiberId.
      const url = cityId
        ? `${this.apiBase}/kanban/fiber-patch?cityId=${encodeURIComponent(cityId)}`
        : `${this.apiBase}/kanban/fiber-patch`
      const res = await fetch(url, {
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

/**
 * Map the daemon's `reason` field from a 422 not_eligible response to a
 * message readable by a human. The daemon currently returns "not_eligible"
 * as a single-value reason; this function is future-proof for when the
 * daemon starts returning richer codes ("not_due", "disabled", "closed").
 */
export function dispatchIneligibleReason(reason: string | undefined): string {
  switch (reason) {
    case 'not_eligible':
      return 'Not currently eligible — the fiber may be disabled, not yet due, or already closed.'
    case 'not_due':
      return 'Not yet due — the next scheduled run hasn\'t arrived yet.'
    case 'disabled':
      return 'Disabled — set shuttle.enabled: true to allow dispatch.'
    case 'closed':
      return 'Fiber is closed — reopen it before dispatching.'
    default:
      return reason
        ? `Not eligible: ${reason}`
        : 'Not currently eligible — fiber may be disabled, not yet due, or closed.'
  }
}

/**
 * Find which column the server has placed a card in, per the last response.
 * The server's classification (in HttpApiKanban.handleKanban) keys off
 * `shuttle.enabled`, `idea` tag, `tempered`, standing-role review state, and
 * other shuttle-block fields. Mirroring all of that on the frontend is a
 * standing source of drift; instead, we trust the placement on the response
 * and look up which bucket the card landed in. Returns null when the card
 * isn't in the response (just-created, just-deleted, or stale local view).
 */
const ALL_COLUMN_KINDS: ColumnKind[] = ['ideas', 'drafts', 'inFlight', 'awaitingReview', 'tempered', 'composted']
function findCardColumn(resp: KanbanResponse | null, id: string): ColumnKind | null {
  if (!resp) return null
  for (const kind of ALL_COLUMN_KINDS) {
    if (resp.columns[kind].some(c => c.id === id)) return kind
  }
  return null
}

function findCardById(resp: KanbanResponse | null, id: string): KanbanCard | null {
  if (!resp) return null
  for (const kind of ALL_COLUMN_KINDS) {
    const hit = resp.columns[kind].find(c => c.id === id)
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
