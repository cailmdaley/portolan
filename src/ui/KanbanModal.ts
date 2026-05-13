/**
 * KanbanModal — three-surface view of Shuttle-managed fibers.
 *
 * Top-to-bottom on a long page:
 *
 *   Now      — the desk. Three lifecycle columns (Drafts | In flight |
 *              Awaiting review). The dense workflow board for what's
 *              actively being worked.
 *   Timeline — the road behind and ahead. Past landings on the left,
 *              future-dated soon fibers on the right, an anytime-soon
 *              pool below for soon fibers without a due date. One
 *              horizontal axis, scrollable.
 *   Stash    — visible cluster grid keyed on containment-path's first
 *              meaningful project token. Held-open clusters (cold:true)
 *              appear below warm clusters in a dimmer style.
 *
 * Interaction:
 *   • Drag a card down onto a timeline date column → horizon=soon,
 *     due=that date.
 *   • Drag onto the anytime-soon pool → horizon=soon, due cleared.
 *   • Drag into the stash → horizon=stashed.
 *   • Drag back up to the now-board → horizon=now (cold clears,
 *     due preserved so a deadline-bearing fiber stays drift-eligible).
 *   • Drop on a now-board column header preserves the existing
 *     /kanban/transition lifecycle path.
 *   • Click a card body to open its detail modal.
 *
 * The frontend never reclassifies — column placement is the server's
 * `classifyFiber`, and the response groups cards by surface. The drag
 * handler's only knob is which (horizon, due, cold) tuple to POST.
 */

import './KanbanModal.css'
import { renderMarkdown } from './utils.js'
import { shouldRunVisiblePoll } from '../runtime/PageAttention'

/** Column identifier within the Now surface — also doubles as the API target. */
type ColumnKind = 'ideas' | 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered' | 'composted'
type HorizonKind = 'now' | 'soon' | 'stashed'

const COLUMN_TITLES: Record<ColumnKind, string> = {
  ideas: 'Ideas',
  drafts: 'Drafts',
  inFlight: 'In flight',
  awaitingReview: 'Awaiting review',
  tempered: 'Tempered',
  composted: 'Composted',
}

type NowColumnKind = 'drafts' | 'inFlight' | 'awaitingReview'
const NOW_COLUMN_ORDER: NowColumnKind[] = ['drafts', 'inFlight', 'awaitingReview']

/** How far back / forward the timeline renders by default. The
 *  constitution caps past at ~30 days; we go ~14d either way so the
 *  visible window stays compact while leaving room to scroll. Older
 *  closed fibers exist in the response but rely on scroll-to-see. */
const TIMELINE_PAST_DAYS = 14
const TIMELINE_FUTURE_DAYS = 14
// 225px per day column → ~7 days visible at a time in the standard
// kanban modal viewport (~1574px wide). The wrap stays horizontally
// scrollable for the full ±14d range.
const TIMELINE_DAY_WIDTH_PX = 225

/** Stash cluster-key derivation: skip umbrella roots (`ai-futures`,
 *  `ai`) and use the first project-level segment instead. Containment-
 *  path remains the load-bearing axis (always present, no user
 *  effort); the skip list is empirically-noisy umbrellas that don't
 *  carry meaning for the user. */
const CLUSTER_KEY_SKIP_ROOTS = new Set<string>(['ai-futures', 'ai'])

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
  due?: string
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
   * Fiber id in Shuttle's canonical felt store. City-scoped kanban cards may
   * use project-relative ids for navigation; dispatch must use this id.
   */
  shuttleFiberId?: string
  /**
   * Session UUID of the most recently dispatched worker when frontmatter
   * still carries one. Display-only hint data: Resume always tries, and
   * Shuttle resolves the actual session at dispatch time.
   */
  sessionId?: string
  /** `shuttle.enabled`, used by the server when this card is sent as transition context. */
  shuttleEnabled?: boolean
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
   * POST /kanban/transition) before an ad-hoc dispatch: the daemon rejects
   * `awaiting` state until the pending review is resolved.
   */
  shuttleReviewState?: 'scheduled' | 'awaiting' | 'accepted'
  /** Raw valid top-level `horizon:` value from fiber frontmatter, if present. */
  storedHorizon?: HorizonKind
  /** Surface this card lives on after due-date promotion. */
  effectiveHorizon: HorizonKind
  /** True when `due:` promotes a non-now stored horizon into Now. */
  drifted: boolean
  /** Top-level `cold:` flag; held-open cluster marker on stashed cards. */
  cold?: boolean
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
  /** Now surface — the desk (3 columns). */
  now: {
    drafts: KanbanCard[]
    inFlight: KanbanCard[]
    awaitingReview: KanbanCard[]
  }
  /** Timeline surface — past, future-dated, anytime-soon. */
  timeline: {
    past: KanbanCard[]
    futureDated: KanbanCard[]
    anytimeSoon: KanbanCard[]
  }
  /** Stash surface — horizon=stashed; frontend clusters by containment path. */
  stash: KanbanCard[]
  /** Speculative pool — off-screen of the three surfaces, unchanged behavior. */
  ideas: KanbanCard[]
  totals: {
    ideas: number
    drafts: number
    inFlight: number
    awaitingReview: number
    past: number
    futureDated: number
    anytimeSoon: number
    stash: number
  }
  /** Historical: total tempered count. Equals
   *  `timeline.past.filter(c => c.tempered === true).length`. */
  temperedTotal: number
  /**
   * Per-origin freshness, keyed by `originId`. Always includes `local`
   * and an entry for every remote origin with a snapshot in the store.
   * The frontend reads this to render the "waiting on `<hostname>`"
   * stale badge and to disable drag for stale-origin cards.
   */
  staleness: Record<string, KanbanOriginStaleness>
  shuttleDiagnostics?: {
    remoteSnapshots: RemoteShuttleSnapshotDiagnostic[]
  }
  remoteScope?: {
    originId: string
    hostname: string
  }
  tagIndex?: string[]
  generatedAt: number
}

type LegacyKanbanResponse = Partial<KanbanResponse> & {
  columns?: Partial<Record<ColumnKind, KanbanCard[]>>
}

interface RemoteShuttleSnapshotDiagnostic {
  originId: string
  receivedAt: string
  eligibleCount: number | null
  blockedCount: number | null
  orphanCount: number | null
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
  bodyTop: number
  columns: Partial<Record<ColumnKind, number>>
  timelineLeft?: number
}

/** Stash cluster: project key + warmth + cards under that key. */
interface StashCluster {
  key: string
  cold: boolean
  cards: KanbanCard[]
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
  private dragSourceId: string | null = null
  private dragAutoScrollFrame: number | null = null
  private dragAutoScrollVelocity = 0
  /** Horizontal edge-scroll for the timeline wrap during drag. Lets the
   *  user drag a card from Now toward the timeline's left/right edge to
   *  auto-scroll into off-screen days. Separate from the body's vertical
   *  drag scroll so they can run concurrently. */
  private timelineEdgeScrollFrame: number | null = null
  private timelineEdgeScrollVelocity = 0
  private timelineEdgeScrollTarget: HTMLElement | null = null
  private bannerTimer: number | null = null
  private hasClaimedInitialFocus = false
  /** Null = global (default). Set by mount(...{cityScope}); cleared by
   *  unmount(). */
  private cityScope: KanbanCityScope | null = null
  /** Bug 3: lightweight auto-poll while mounted. 15s default. */
  private pollTimer: number | null = null
  private readonly pollIntervalMs = 15_000
  private lastFetchStartedAt: number | null = null
  /** Disconnects ResizeObserver + scroll listener installed by the timeline
   *  strip's adaptive-height handler. Called at the start of each render
   *  (the strip gets rebuilt) and on unmount. */
  private timelineAdaptiveCleanup: (() => void) | null = null
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
    this.timelineAdaptiveCleanup?.()
    this.timelineAdaptiveCleanup = null
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
    this.container.setAttribute('aria-label', 'Kanban')

    const header = document.createElement('div')
    header.className = 'kbn-header'

    const title = document.createElement('div')
    title.className = 'kbn-title'
    title.textContent = 'Kanban'
    this.subtitleEl = document.createElement('div')
    this.subtitleEl.className = 'kbn-subtitle'
    this.subtitleEl.textContent = this.subtitleText()

    // Title row (title + scope subtitle) and stats row stack vertically
    // on the left so the header band — sized by the thumb-index — fills
    // with content instead of leaving a horizontal stats line floating
    // in the middle.
    const titleRow = document.createElement('div')
    titleRow.className = 'kbn-title-wrap'
    titleRow.append(title, this.subtitleEl)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'kbn-status'
    this.statusEl.textContent = 'Loading…'

    const titleBlock = document.createElement('div')
    titleBlock.className = 'kbn-title-block'
    titleBlock.append(titleRow, this.statusEl)

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

    header.append(titleBlock, refreshBtn)

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

    try {
      if (target === 'inFlight' && card.status === 'closed' && card.shuttleKind !== undefined) {
        const commentRes = await fetch(this.reviewCommentUrl(this.cityScope?.cityId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fiberId: card.id,
            directive: '',
            resumeMode: 'fresh',
            interactive: false,
          }),
        })
        if (!commentRes.ok) {
          const errBody = await commentRes.json().catch(() => ({ error: `${commentRes.status}` })) as { error?: string }
          throw new Error(errBody.error || `review-comment ${commentRes.status}`)
        }
      }
      if (fromKind === target) return
      const res = await fetch(this.transitionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiberId: card.id, target, card }),
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

  /**
   * POST a surface edit. Threads horizon + optional cold + optional due
   * through `/kanban/horizon` so the drag is one atomic write.
   *
   *   • Drag onto a timeline date column → setSurface(card, 'soon', { due }).
   *   • Drag onto the anytime-soon pool   → setSurface(card, 'soon', { due: null }).
   *   • Drag into stash                   → setSurface(card, 'stashed', { cold? }).
   *   • Drag back up to now               → setSurface(card, 'now').
   *
   * When `opts.due` is omitted the existing `due:` is preserved; pass
   * `null` to clear it explicitly (e.g. on the anytime-soon pool drop).
   */
  private async setSurface(
    card: KanbanCard,
    horizon: HorizonKind,
    opts: { cold?: boolean; due?: string | null } = {},
  ): Promise<void> {
    const wantsCold = horizon === 'stashed' ? (opts.cold ?? false) : undefined
    const sameHorizon =
      card.storedHorizon === horizon && (card.cold ?? false) === (opts.cold ?? false)
    const sameDue = opts.due === undefined || (card.due ?? null) === opts.due
    if (sameHorizon && sameDue) return

    try {
      const payload: Record<string, unknown> = { fiberId: card.id, horizon, card }
      if (wantsCold !== undefined) payload.cold = wantsCold
      if (opts.due !== undefined) payload.due = opts.due
      const res = await fetch(this.horizonUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `${res.status}` })) as { error?: string }
        throw new Error(errBody.error || `Surface edit failed: ${res.status}`)
      }
      this.announce(`Moved “${card.name}” to ${SURFACE_TITLE[horizon]}.`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't move “${card.name}” to ${SURFACE_TITLE[horizon]}: ${msg}`, 'error')
      this.announce(`Surface move failed: ${msg}`)
    }
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
    this.lastFetchStartedAt = Date.now()
    const token = ++this.inflightFetchToken
    if (this.statusEl) this.statusEl.textContent = 'Loading…'
    try {
      const res = await fetch(this.kanbanUrl())
      if (token !== this.inflightFetchToken) return
      if (!res.ok) {
        this.renderError(`Server returned ${res.status}`)
        return
      }
      const data = normalizeKanbanResponse(await res.json())
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
    // Hash the three surfaces + totals — that's the rendered surface;
    // generatedAt and staleness flicker per poll even on no-op refreshes.
    return JSON.stringify({
      n: data.now,
      tl: data.timeline,
      s: data.stash,
      i: data.ideas,
      t: data.totals,
      tt: data.temperedTotal,
      sd: shuttleDiagnosticsSignature(data.shuttleDiagnostics),
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
    const { now, timeline, stash, totals, temperedTotal, staleness } = data
    const remoteState = data.remoteScope
      ? staleness[data.remoteScope.originId]
      : undefined
    const remotePrefix = data.remoteScope && remoteState?.status === 'stale'
      ? remoteDisconnectedText(data, remoteState)
      : ''
    const pastCount = timeline.past.length
    const soonCount = totals.futureDated + totals.anytimeSoon
    // Stats line: only show buckets that have something. Drafts / in-flight /
    // awaiting always render (the three Now lanes are the desk); other buckets
    // drop out when zero so the line stays readable.
    const parts: string[] = []
    if (totals.ideas > 0) parts.push(`${totals.ideas} ideas`)
    parts.push(`${totals.drafts} drafts`)
    parts.push(`${totals.inFlight} in flight`)
    parts.push(`${totals.awaitingReview} awaiting`)
    if (pastCount > 0) parts.push(`${pastCount} landed`)
    if (soonCount > 0) parts.push(`${soonCount} soon`)
    if (totals.stash > 0) parts.push(`${totals.stash} stashed`)
    if (temperedTotal > 0) parts.push(`${temperedTotal} tempered`)
    const remoteShuttleText = formatRemoteShuttleDiagnostics(data.shuttleDiagnostics)
    if (remoteShuttleText) parts.push(remoteShuttleText)
    this.statusEl.textContent = remotePrefix + parts.join(' · ')

    // Tear down any per-render observers from the previous strip before we
    // throw away the DOM nodes they observed.
    this.timelineAdaptiveCleanup?.()
    this.timelineAdaptiveCleanup = null

    this.body.innerHTML = ''
    this.body.classList.remove('kbn-body-zoomed')

    this.body.append(this.renderNowSection(now, staleness))
    this.body.append(this.renderTimelineSection(timeline, now.awaitingReview, staleness))
    this.body.append(this.renderStashSection(stash, staleness))

    this.restoreScrollSnapshot(scrollSnapshot)
    this.claimInitialFocus()
    this.updateBodyScrollAffordance()
    window.requestAnimationFrame(() => this.updateBodyScrollAffordance())
    // Expand line-clamp on outcomes in now-section columns with spare
    // vertical space. Two RAFs let layout settle at the 4-line default
    // before measuring scrollHeight.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => this.expandOutcomesToFillSpace())
    })
    // Scroll the timeline strip so today sits ~28% from the left on
    // initial render, matching the playground reference. Skipped when
    // the snapshot already had a horizontal scroll position.
    if (!scrollSnapshot?.timelineLeft) {
      window.requestAnimationFrame(() => this.scrollTimelineToToday())
    }
    this.lastResponse = data
  }

  /** Render the Now surface: section header + 3-column board. */
  private renderNowSection(
    now: KanbanResponse['now'],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-now'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'Now — the desk')

    const board = document.createElement('div')
    board.className = 'kbn-now-board'
    for (const kind of NOW_COLUMN_ORDER) {
      board.append(this.renderColumn(kind, now[kind], staleness))
    }

    section.append(board)
    this.installSectionDragHandlers(section, 'now')
    return section
  }

  /** Render the Timeline surface: scrollable day-column grid with past
   *  landings on the left, today centered, future-dated cards on the
   *  right, and an anytime-soon pool below. */
  private renderTimelineSection(
    timeline: KanbanResponse['timeline'],
    awaitingReview: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-timeline'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'Timeline — past and soon')

    const wrap = document.createElement('div')
    wrap.className = 'kbn-timeline-wrap'
    wrap.dataset.timelineWrap = '1'

    const days = buildTimelineDays(TIMELINE_PAST_DAYS, TIMELINE_FUTURE_DAYS)
    const dayIndex = new Map<string, number>(days.map((d, i) => [d.iso, i]))

    // Axis row: one cell per day, today marked.
    const axis = document.createElement('div')
    axis.className = 'kbn-timeline-axis'
    axis.style.gridTemplateColumns = `repeat(${days.length}, ${TIMELINE_DAY_WIDTH_PX}px)`
    for (const day of days) axis.append(buildDayCell(day))
    wrap.append(axis)

    // Card strip: each card lives at (grid-column = day index + 1, grid-row =
    // its 1-indexed position within that day). Explicit rows are required —
    // CSS Grid's sparse auto-placement advances its cursor forward, so cards
    // arriving in decreasing-column order (the past list is reverse-
    // chronological) would each force a new row and staircase down the strip.
    const strip = document.createElement('div')
    strip.className = 'kbn-timeline-strip'
    strip.style.gridTemplateColumns = `repeat(${days.length}, ${TIMELINE_DAY_WIDTH_PX}px)`

    // Drag drop targets: one transparent column per day so dragover/drop
    // can resolve to a specific date. They span the full strip height via
    // a large explicit row span (CSS `grid-row: 1 / -1` is a no-op without
    // grid-template-rows). Cards added after sit on top in DOM order.
    for (let i = 0; i < days.length; i += 1) {
      const dropCol = document.createElement('div')
      dropCol.className = 'kbn-timeline-dropcol'
      dropCol.style.gridColumn = String(i + 1)
      dropCol.dataset.timelineDayIso = days[i].iso
      this.installTimelineDayDropHandlers(dropCol, days[i].iso)
      strip.append(dropCol)
    }

    // Per-column stack counters: card N on day X lands at grid-row N.
    const rowByCol = new Map<number, number>()
    const nextRow = (col: number): number => {
      const row = (rowByCol.get(col) ?? 0) + 1
      rowByCol.set(col, row)
      return row
    }

    for (const card of timeline.past) {
      const col = dayIndexForIso(card.closedAt, dayIndex)
      if (col === null) continue
      strip.append(this.renderTimelineCard(card, col, nextRow(col), 'past', staleness[card.originId]))
    }
    // Awaiting-review cards project onto their closedAt day as ghosts. They
    // still live in the Now → Awaiting Review column; the timeline ghost is
    // a preview of where the card will land when tempered — answering "what
    // happened today/yesterday?" without lying that the work is settled.
    for (const card of awaitingReview) {
      const col = dayIndexForIso(card.closedAt, dayIndex)
      if (col === null) continue
      strip.append(this.renderTimelineCard(card, col, nextRow(col), 'awaiting', staleness[card.originId]))
    }
    for (const card of timeline.futureDated) {
      const col = dayIndexForIso(card.due, dayIndex)
      if (col === null) continue
      strip.append(this.renderTimelineCard(card, col, nextRow(col), 'future', staleness[card.originId]))
    }
    wrap.append(strip)

    // Adaptive strip height: the strip shrinks to fit the tallest card stack
    // among horizontally-visible day-columns. Most viewports show ~11 days at
    // a time; without this the strip is sized by the absolute tallest stack
    // in the full ±14d window, wasting vertical space whenever the busiest
    // day is off-screen. Recomputed on scroll (rAF-debounced) and on resize.
    this.installAdaptiveStripHeight(wrap, strip, rowByCol, days.length)

    // Edge-scroll on horizontal drag: dragging a card near the left/right
    // edge of the wrap auto-scrolls into off-screen days so the user can
    // drop on Mon-the-18th without having to scroll first.
    this.installTimelineEdgeScroll(wrap)

    // Anytime-soon pool below the strip.
    const pool = document.createElement('div')
    pool.className = 'kbn-anytime-pool'
    pool.dataset.anytimePool = '1'
    const poolLabel = document.createElement('span')
    poolLabel.className = 'kbn-anytime-pool-label'
    poolLabel.textContent = 'anytime soon'
    pool.append(poolLabel)
    for (const card of timeline.anytimeSoon) {
      pool.append(this.renderPoolCard(card, staleness[card.originId]))
    }
    this.installAnytimePoolDropHandlers(pool)
    wrap.append(pool)

    section.append(wrap)
    const timelineCount = timeline.past.length + timeline.futureDated.length + timeline.anytimeSoon.length
    this.installSectionChrome(section, 'timeline', 'Past · Soon', timelineCount)
    return section
  }

  /** Bind a scroll + resize listener that sizes the strip to fit the max
   *  card stack among horizontally-visible day-columns. Reasoning: the
   *  strip's natural CSS-Grid height is set by the absolute tallest stack
   *  anywhere in the ±14d window, which wastes vertical space whenever the
   *  busiest day is scrolled off-screen. Cleanup is stored on
   *  `this.timelineAdaptiveCleanup` so renderResponse() can disconnect
   *  before throwing away the strip. */
  private installAdaptiveStripHeight(
    wrap: HTMLElement,
    strip: HTMLElement,
    rowByCol: Map<number, number>,
    totalDays: number,
  ): void {
    const ROW_PX = 22
    const STRIP_PADDING_PX = 6
    const recompute = (): void => {
      const sLeft = wrap.scrollLeft
      const sRight = sLeft + wrap.clientWidth
      const firstCol = Math.max(0, Math.floor(sLeft / TIMELINE_DAY_WIDTH_PX))
      const lastCol = Math.min(totalDays - 1, Math.floor((sRight - 1) / TIMELINE_DAY_WIDTH_PX))
      let maxRows = 1
      for (let c = firstCol; c <= lastCol; c += 1) {
        const r = rowByCol.get(c)
        if (r !== undefined && r > maxRows) maxRows = r
      }
      strip.style.height = `${maxRows * ROW_PX + STRIP_PADDING_PX}px`
    }
    let rafScheduled = false
    const schedule = (): void => {
      if (rafScheduled) return
      rafScheduled = true
      window.requestAnimationFrame(() => {
        rafScheduled = false
        recompute()
      })
    }
    wrap.addEventListener('scroll', schedule, { passive: true })
    // ResizeObserver isn't always present (older test envs / jsdom);
    // scroll + RAF still give a good experience without it.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    ro?.observe(wrap)
    // Initial measurement once layout has settled.
    window.requestAnimationFrame(recompute)

    this.timelineAdaptiveCleanup = () => {
      wrap.removeEventListener('scroll', schedule)
      ro?.disconnect()
    }
  }

  /** Edge-scroll the timeline wrap when a drag approaches its left or
   *  right edge. Mirrors the body's vertical drag-scroll: a soft 80-px
   *  edge zone, velocity scaled by `pressure^1.35` so the closer to the
   *  edge the user gets, the faster the strip scrolls. Listeners live
   *  on `wrap` and tear down naturally when the strip is re-rendered. */
  private installTimelineEdgeScroll(wrap: HTMLElement): void {
    const EDGE_PX = 80
    const MAX_STEP_PX = 28
    const onDragOver = (e: DragEvent): void => {
      if (!this.dragSourceId) return
      // The dropcols inside the wrap have their own dragover handler with
      // `preventDefault + stopPropagation`. We're listening on the wrap
      // *before* those bubble back up to body — and we still want the day
      // drop targets to be "the drop target." So we just compute velocity
      // here and let dropcol handlers continue to claim the drop itself.
      const r = wrap.getBoundingClientRect()
      const leftPressure = Math.max(0, EDGE_PX - (e.clientX - r.left))
      const rightPressure = Math.max(0, EDGE_PX - (r.right - e.clientX))
      const direction = rightPressure > 0 ? 1 : leftPressure > 0 ? -1 : 0
      const pressure = Math.max(leftPressure, rightPressure) / EDGE_PX
      this.timelineEdgeScrollVelocity = direction === 0
        ? 0
        : direction * Math.max(6, Math.round(Math.pow(pressure, 1.35) * MAX_STEP_PX))
      if (this.timelineEdgeScrollVelocity === 0) {
        this.stopTimelineEdgeScroll()
        return
      }
      this.timelineEdgeScrollTarget = wrap
      this.startTimelineEdgeScroll()
    }
    const onDragLeave = (e: DragEvent): void => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget as Node)) return
      this.stopTimelineEdgeScroll()
    }
    const onDrop = (): void => this.stopTimelineEdgeScroll()
    wrap.addEventListener('dragover', onDragOver)
    wrap.addEventListener('dragleave', onDragLeave)
    wrap.addEventListener('drop', onDrop)
  }

  private startTimelineEdgeScroll(): void {
    if (this.timelineEdgeScrollFrame !== null) return
    const tick = (): void => {
      const target = this.timelineEdgeScrollTarget
      if (!target || !this.dragSourceId || this.timelineEdgeScrollVelocity === 0) {
        this.stopTimelineEdgeScroll()
        return
      }
      target.scrollLeft += this.timelineEdgeScrollVelocity
      this.timelineEdgeScrollFrame = window.requestAnimationFrame(tick)
    }
    this.timelineEdgeScrollFrame = window.requestAnimationFrame(tick)
  }

  private stopTimelineEdgeScroll(): void {
    this.timelineEdgeScrollVelocity = 0
    this.timelineEdgeScrollTarget = null
    if (this.timelineEdgeScrollFrame === null) return
    window.cancelAnimationFrame(this.timelineEdgeScrollFrame)
    this.timelineEdgeScrollFrame = null
  }

  /** Render the Stash surface: cluster grid keyed by containment-path's
   *  first meaningful project segment. Warm clusters first, then a
   *  divider, then held-open clusters in a dimmer style. */
  private renderStashSection(
    stash: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-stash'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'Stash — set aside, visible')

    const clusters = clusterStashCards(stash)
    const warm = clusters.filter((c) => !c.cold)
    const cold = clusters.filter((c) => c.cold)

    const grid = document.createElement('div')
    grid.className = 'kbn-cluster-grid'
    for (const c of warm) grid.append(this.renderCluster(c, staleness))
    if (cold.length > 0) {
      const divider = document.createElement('div')
      divider.className = 'kbn-cluster-divider'
      divider.setAttribute('aria-hidden', 'true')
      divider.textContent = '— held open —'
      grid.append(divider)
      for (const c of cold) grid.append(this.renderCluster(c, staleness))
    }
    if (clusters.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-cluster-empty'
      empty.textContent = '— nothing stashed —'
      grid.append(empty)
    }

    section.append(grid)
    this.installSectionDragHandlers(section, 'stashed')
    return section
  }

  /** Section chrome shared across Now / Timeline / Stash: the section heads
   *  retired (the layout speaks), but each section gets a subtle top-right
   *  collapse toggle and a compact strip (label + count) that takes over
   *  the section's footprint when collapsed. Persists per-section collapse
   *  in localStorage so users who keep, say, Stash collapsed for drag-target
   *  ergonomics aren't asked to re-collapse each session.
   *
   *  Drops still fire on the section root (and therefore on the collapsed
   *  strip), so a drag from Now to a collapsed Stash lands cleanly. */
  private installSectionChrome(
    section: HTMLElement,
    key: 'now' | 'timeline' | 'stash',
    label: string,
    count: number,
  ): void {
    const collapsed = readSectionCollapsed(key)
    if (collapsed) section.classList.add('kbn-section-collapsed')

    const strip = document.createElement('div')
    strip.className = 'kbn-section-strip'
    strip.setAttribute('aria-hidden', collapsed ? 'false' : 'true')
    const stripLabel = document.createElement('span')
    stripLabel.className = 'kbn-section-strip-label'
    stripLabel.textContent = label
    const stripCount = document.createElement('span')
    stripCount.className = 'kbn-section-strip-count'
    stripCount.textContent = count > 0 ? String(count) : '—'
    strip.append(stripLabel, stripCount)
    strip.addEventListener('click', () => toggle())
    section.append(strip)

    const toggleBtn = document.createElement('button')
    toggleBtn.type = 'button'
    toggleBtn.className = 'kbn-section-toggle'
    const updateAria = (isCollapsed: boolean) => {
      toggleBtn.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${label}`)
      toggleBtn.title = isCollapsed ? `Expand ${label}` : `Collapse ${label}`
      toggleBtn.textContent = isCollapsed ? '⌃' : '⌄'
      strip.setAttribute('aria-hidden', isCollapsed ? 'false' : 'true')
    }
    updateAria(collapsed)
    const toggle = (): void => {
      const next = !section.classList.contains('kbn-section-collapsed')
      section.classList.toggle('kbn-section-collapsed', next)
      writeSectionCollapsed(key, next)
      updateAria(next)
    }
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggle()
    })
    section.append(toggleBtn)
  }

  /** Install drop handlers on a section (Now or Stash) — drop anywhere
   *  inside the section that isn't a column header writes the surface
   *  horizon for the card. Now writes 'now'; Stash writes 'stashed'. */
  private installSectionDragHandlers(section: HTMLElement, horizon: 'now' | 'stashed'): void {
    section.addEventListener('dragover', (e) => {
      if (!this.dragSourceId) return
      // Column header drops still mean "transition to this lifecycle
      // bucket" — handled by the head's own drop listener.
      if ((e.target as HTMLElement).closest('.kbn-col-head')) return
      // Timeline date columns inside Timeline shouldn't trigger this
      // section handler — the section is Now/Stash only.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      section.classList.add('kbn-section-drop')
    })
    section.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && section.contains(e.relatedTarget as Node)) return
      section.classList.remove('kbn-section-drop')
    })
    section.addEventListener('drop', (e) => {
      if ((e.target as HTMLElement).closest('.kbn-col-head')) return
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.dragSourceId
      section.classList.remove('kbn-section-drop')
      this.dragSourceId = null
      this.stopDragAutoScroll()
      if (!fiberId) return
      e.preventDefault()
      const card = findCardById(this.lastResponse, fiberId)
      if (!card) return
      void this.setSurface(card, horizon)
    })
  }

  private installTimelineDayDropHandlers(dropCol: HTMLElement, iso: string): void {
    dropCol.addEventListener('dragover', (e) => {
      if (!this.dragSourceId) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      dropCol.classList.add('kbn-timeline-dropcol-active')
    })
    dropCol.addEventListener('dragleave', () => {
      dropCol.classList.remove('kbn-timeline-dropcol-active')
    })
    dropCol.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.dragSourceId
      dropCol.classList.remove('kbn-timeline-dropcol-active')
      this.dragSourceId = null
      this.stopDragAutoScroll()
      if (!fiberId) return
      const card = findCardById(this.lastResponse, fiberId)
      if (!card) return
      // Past-date drops are not supported (past is a record, not a plan).
      // Today's column promotes to now via horizon=now; future dates set
      // horizon=soon + the chosen due date.
      const today = isoDay(new Date())
      if (iso < today) return
      if (iso === today) {
        void this.setSurface(card, 'now', { due: null })
      } else {
        void this.setSurface(card, 'soon', { due: iso })
      }
    })
  }

  private installAnytimePoolDropHandlers(pool: HTMLElement): void {
    pool.addEventListener('dragover', (e) => {
      if (!this.dragSourceId) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      pool.classList.add('kbn-anytime-pool-drop')
    })
    pool.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && pool.contains(e.relatedTarget as Node)) return
      pool.classList.remove('kbn-anytime-pool-drop')
    })
    pool.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.dragSourceId
      pool.classList.remove('kbn-anytime-pool-drop')
      this.dragSourceId = null
      this.stopDragAutoScroll()
      if (!fiberId) return
      const card = findCardById(this.lastResponse, fiberId)
      if (!card) return
      void this.setSurface(card, 'soon', { due: null })
    })
  }

  /** Render a single cluster (project name + count + items list). */
  private renderCluster(
    cluster: StashCluster,
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const el = document.createElement('div')
    el.className = cluster.cold ? 'kbn-cluster kbn-cluster-cold' : 'kbn-cluster'
    el.dataset.clusterKey = cluster.key

    const head = document.createElement('div')
    head.className = 'kbn-cluster-head'
    const name = document.createElement('span')
    name.className = 'kbn-cluster-name'
    name.textContent = cluster.key
    const count = document.createElement('span')
    count.className = 'kbn-cluster-count'
    count.textContent = String(cluster.cards.length)
    head.append(name, count)
    if (cluster.cold) {
      const tag = document.createElement('span')
      tag.className = 'kbn-cluster-tag'
      tag.textContent = 'held open'
      head.append(tag)
    }
    el.append(head)

    for (const card of cluster.cards) {
      el.append(this.renderClusterItem(card, staleness[card.originId]))
    }
    return el
  }

  private renderClusterItem(
    card: KanbanCard,
    staleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = staleness?.status === 'stale'
    const el = document.createElement('div')
    el.className = isAgentCard(card) ? 'kbn-cluster-item kbn-cluster-item-agent' : 'kbn-cluster-item kbn-cluster-item-human'
    el.draggable = !isStale
    el.dataset.fiberId = card.id
    el.title = card.name
    el.setAttribute('role', 'listitem')
    el.setAttribute('aria-label', card.name)

    if (!isStale) {
      el.addEventListener('dragstart', (e) => {
        this.dragSourceId = card.id
        el.classList.add('kbn-card-dragging')
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/x-fiber-id', card.id)
        }
      })
      el.addEventListener('dragend', () => {
        el.classList.remove('kbn-card-dragging')
        this.dragSourceId = null
      })
    }

    const glyph = document.createElement('span')
    glyph.className = 'kbn-cluster-item-glyph'
    glyph.textContent = isAgentCard(card) ? '◐' : '✓'
    const title = document.createElement('span')
    title.className = 'kbn-cluster-item-title'
    // Show the leaf segment of the id rather than the full name for
    // cluster items — the cluster header already names the project,
    // so the leaf is the disambiguator.
    title.textContent = card.name
    el.append(glyph, title)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      this.detailModal?.open(card, this.cityScope?.cityId, 'drafts')
    })
    return el
  }

  /** Compact card variant for the timeline strip — single-line with
   *  glyph + title, color-coded by past/future/agent/human. The caller
   *  supplies the 1-indexed row within the card's day column so that
   *  multiple cards on the same day stack vertically while different
   *  days share row 1. */
  private renderTimelineCard(
    card: KanbanCard,
    column: number,
    row: number,
    kind: 'past' | 'future' | 'awaiting',
    staleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = staleness?.status === 'stale'
    const isComposted = kind === 'past' && card.tempered === false
    const variantClass = kind === 'past'
      ? (isComposted ? 'kbn-tl-card-composted' : 'kbn-tl-card-past')
      : kind === 'awaiting'
        ? 'kbn-tl-card-awaiting'
        : (isAgentCard(card) ? 'kbn-tl-card-agent' : 'kbn-tl-card-human')

    const el = document.createElement('div')
    el.className = `kbn-tl-card ${variantClass}${isStale ? ' kbn-card--stale' : ''}`
    el.style.gridColumn = String(column + 1)
    el.style.gridRow = String(row)
    el.draggable = !isStale && kind === 'future'
    el.dataset.fiberId = card.id
    el.title = card.name
    el.setAttribute('role', 'listitem')

    if (!isStale && kind === 'future') {
      el.addEventListener('dragstart', (e) => {
        this.dragSourceId = card.id
        el.classList.add('kbn-card-dragging')
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/x-fiber-id', card.id)
        }
      })
      el.addEventListener('dragend', () => {
        el.classList.remove('kbn-card-dragging')
        this.dragSourceId = null
      })
    }

    const glyph = document.createElement('span')
    glyph.className = 'kbn-tl-card-glyph'
    glyph.textContent = kind === 'past'
      ? (isComposted ? '✗' : '✓')
      : kind === 'awaiting'
        ? '◌'
        : (isAgentCard(card) ? '◐' : '✓')
    const title = document.createElement('span')
    title.className = 'kbn-tl-card-title'
    title.textContent = card.name
    el.append(glyph, title)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      const colKind: ColumnKind = kind === 'past'
        ? (isComposted ? 'composted' : 'tempered')
        : kind === 'awaiting'
          ? 'awaitingReview'
          : 'drafts'
      this.detailModal?.open(card, this.cityScope?.cityId, colKind)
    })
    return el
  }

  private renderPoolCard(
    card: KanbanCard,
    staleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = staleness?.status === 'stale'
    const el = document.createElement('span')
    el.className = isAgentCard(card)
      ? 'kbn-anytime-pool-card kbn-anytime-pool-card-agent'
      : 'kbn-anytime-pool-card kbn-anytime-pool-card-human'
    el.draggable = !isStale
    el.dataset.fiberId = card.id
    el.title = card.name

    if (!isStale) {
      el.addEventListener('dragstart', (e) => {
        this.dragSourceId = card.id
        el.classList.add('kbn-card-dragging')
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/x-fiber-id', card.id)
        }
      })
      el.addEventListener('dragend', () => {
        el.classList.remove('kbn-card-dragging')
        this.dragSourceId = null
      })
    }

    const glyph = document.createElement('span')
    glyph.className = 'kbn-anytime-pool-card-glyph'
    glyph.textContent = isAgentCard(card) ? '◐' : '✓'
    const title = document.createElement('span')
    title.className = 'kbn-anytime-pool-card-title'
    title.textContent = card.name
    el.append(glyph, title)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      this.detailModal?.open(card, this.cityScope?.cityId, 'drafts')
    })
    return el
  }

  /** Position the timeline horizontal scroll so today sits at ~28% from
   *  the left, matching the playground reference. Skipped when the
   *  snapshot already had a horizontal scroll position. */
  private scrollTimelineToToday(): void {
    if (!this.body) return
    const wrap = this.body.querySelector<HTMLElement>('[data-timeline-wrap]')
    if (!wrap) return
    const todayOffset = TIMELINE_PAST_DAYS * TIMELINE_DAY_WIDTH_PX
    const target = todayOffset - wrap.clientWidth * 0.28
    wrap.scrollLeft = Math.max(0, target)
  }

  /**
   * Per-column post-render pass that sets `--card-line-clamp` to fill
   * the column with at most 3 visible cards. The goal: maximize on-
   * screen space utilization while never showing more than three cards
   * in a single column at once.
   *
   * Algorithm per column:
   *   1. effectiveN = min(card_count, 3) — how many cards we want
   *      visible at once. Beyond 3, the column scrolls and unseen cards
   *      stay at the same height as the visible ones.
   *   2. targetCardHeight = (column_height - gaps_between_visible_cards)
   *      / effectiveN. The height each card should grow toward.
   *   3. avgNonOutcomeHeight = (sum of non-outcome height across cards
   *      in the column) / N. The ambient overhead — header + name +
   *      slug + meta + padding + gaps — varies card-to-card so we
   *      average it.
   *   4. targetOutcomeHeight = targetCardHeight - avgNonOutcomeHeight.
   *   5. targetLines = floor(targetOutcomeHeight / line_height).
   *   6. Clamp lives in [4, 16]. Apply to .kbn-col so all cards
   *      inherit via the cascade.
   *
   * Floor() biases toward undershoot. The clamp is per-column so
   * sparser columns can show longer outcomes — each column is sized
   * to fit its own contents, not a global lowest common denominator.
   */
  private expandOutcomesToFillSpace(): void {
    if (!this.body) return
    // Outcome font-size × line-height = 12.5 × 1.4 = 17.5px per line.
    const lineHeight = 17.5
    // Gap between cards in .kbn-col-list (CSS: gap: 8px).
    const cardGap = 8
    const minClamp = 4
    const maxVisibleCards = 3
    // No upper cap on the clamp value: targetLines is already bounded by
    // (column_height - overhead) / lineHeight, so a single-card column
    // expands to fill the column. Cards with short outcomes show their
    // full content (line-clamp is a max, not a fixed height) — the
    // overgrown clamp value is harmless when there's nothing to clamp.

    // Reset cascade roots before measuring so a stale variable from a
    // prior render doesn't bias offsetHeight readings. Clear at every
    // level we might have set it (body, col, card).
    this.body.style.removeProperty('--card-line-clamp')
    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col')) {
      col.style.removeProperty('--card-line-clamp')
    }
    for (const card of this.body.querySelectorAll<HTMLElement>('.kbn-card')) {
      card.style.removeProperty('--card-line-clamp')
    }
    // Force layout to settle at the 4-line default before measuring.
    void this.body.offsetHeight

    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col')) {
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      if (!list) continue
      const cards = list.querySelectorAll<HTMLElement>('.kbn-card')
      if (cards.length === 0) continue

      const effectiveN = Math.min(cards.length, maxVisibleCards)
      const totalGapHeight = (effectiveN - 1) * cardGap
      // Subtract a small per-column safety buffer — browser line-height
      // computation rounds at sub-pixel boundaries, and rounding up by
      // half a pixel × N cards adds up to a couple pixels of overshoot.
      // This buffer gives us guaranteed undershoot at the cost of a
      // hairline of empty space at the column bottom — exactly the
      // tradeoff the user asked for.
      const safetyBuffer = 4
      const targetCardHeight =
        (list.clientHeight - totalGapHeight - safetyBuffer) / effectiveN

      // Use the MAX non-outcome height across cards in the column, not
      // the average. Awaiting-review cards carry [Temper][Compost] in
      // the meta row which adds a couple pixels over the in-flight
      // baseline; in-flight cards may carry the worker pill. Sizing to
      // the average over-allocates outcome space to the chunkier cards,
      // which is exactly the overshoot symptom. Max is conservative.
      let maxNonOutcome = 0
      for (const card of cards) {
        const outcome = card.querySelector<HTMLElement>('.kbn-card-outcome')
        const outcomeHeight = outcome ? outcome.offsetHeight : 0
        const nonOutcome = card.offsetHeight - outcomeHeight
        if (nonOutcome > maxNonOutcome) maxNonOutcome = nonOutcome
      }

      const targetOutcomeHeight = targetCardHeight - maxNonOutcome
      if (targetOutcomeHeight <= 0) continue

      const targetLines = Math.floor(targetOutcomeHeight / lineHeight)
      const clamp = Math.max(minClamp, targetLines)
      if (clamp <= minClamp) continue

      col.style.setProperty('--card-line-clamp', String(clamp))
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
    const timeline = this.body.querySelector<HTMLElement>('[data-timeline-wrap]')
    return {
      bodyLeft: this.body.scrollLeft,
      bodyTop: this.body.scrollTop,
      columns,
      timelineLeft: timeline?.scrollLeft,
    }
  }

  private restoreScrollSnapshot(snapshot: KanbanScrollSnapshot | null): void {
    if (!this.body || !snapshot) return

    const restore = (): void => {
      if (!this.body) return
      this.body.scrollLeft = snapshot.bodyLeft
      this.body.scrollTop = snapshot.bodyTop
      for (const [kind, scrollTop] of Object.entries(snapshot.columns) as [ColumnKind, number][]) {
        const list = this.body.querySelector<HTMLElement>(`.kbn-col[data-column="${kind}"] .kbn-col-list`)
        if (list) list.scrollTop = scrollTop
      }
      if (snapshot.timelineLeft !== undefined) {
        const timeline = this.body.querySelector<HTMLElement>('[data-timeline-wrap]')
        if (timeline) timeline.scrollLeft = snapshot.timelineLeft
      }
      this.updateBodyScrollAffordance()
    }

    restore()
    window.requestAnimationFrame(restore)
  }

  /**
   * Render one Now-surface column (Drafts / In Flight / Awaiting). The
   * column header doubles as the lifecycle-transition drop target;
   * card-body drops on the column itself are absorbed by the section's
   * drop handler (which writes horizon=now via setSurface).
   */
  private renderColumn(
    kind: ColumnKind,
    cards: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const title = COLUMN_TITLES[kind]
    const col = document.createElement('section')
    col.className = `kbn-col kbn-col-${kind}`
    col.setAttribute('role', 'region')
    col.setAttribute('aria-label', `${title} (${cards.length})`)
    col.dataset.column = kind

    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'kbn-col-head'
    head.setAttribute('aria-label', `Drop here to move to ${title}`)
    const headTitle = document.createElement('h2')
    headTitle.className = 'kbn-col-title'
    headTitle.textContent = title
    const headCount = document.createElement('span')
    headCount.className = 'kbn-col-count'
    headCount.textContent = String(cards.length)
    head.append(headTitle, headCount)

    const onHeaderDragOver = (e: DragEvent): void => {
      if (!this.dragSourceId) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      col.classList.add('kbn-col-drop')
    }
    const onHeaderDragLeave = (e: DragEvent): void => {
      if (e.relatedTarget && head.contains(e.relatedTarget as Node)) return
      col.classList.remove('kbn-col-drop')
    }
    const onHeaderDrop = (e: DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.dragSourceId
      col.classList.remove('kbn-col-drop')
      this.dragSourceId = null
      this.stopDragAutoScroll()
      if (!fiberId) return
      const card = findCardById(this.lastResponse, fiberId)
      if (!card) return
      void this.transition(card, kind)
    }
    head.addEventListener('dragover', onHeaderDragOver)
    head.addEventListener('dragleave', onHeaderDragLeave)
    head.addEventListener('drop', onHeaderDrop)

    const onColumnDragOver = (e: DragEvent): void => {
      if (!this.dragSourceId) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      col.classList.add('kbn-col-drop')
    }
    const onColumnDragLeave = (e: DragEvent): void => {
      if (e.relatedTarget && col.contains(e.relatedTarget as Node)) return
      col.classList.remove('kbn-col-drop')
    }
    const onColumnDrop = (e: DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.dragSourceId
      col.classList.remove('kbn-col-drop')
      this.dragSourceId = null
      this.stopDragAutoScroll()
      if (!fiberId) return
      const card = findCardById(this.lastResponse, fiberId)
      if (!card) return
      void this.transition(card, kind)
    }
    col.addEventListener('dragover', onColumnDragOver)
    col.addEventListener('dragleave', onColumnDragLeave)
    col.addEventListener('drop', onColumnDrop)

    const list = document.createElement('div')
    list.className = 'kbn-col-list'
    list.setAttribute('role', 'list')

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

    col.append(head, list)
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

    // Header row: glyph + title. The lifecycle column already provides
    // status context, so the card face uses actor/deadline instead of tags
    // or status chips.
    const headerRow = document.createElement('div')
    headerRow.className = 'kbn-card-header'

    const glyph = document.createElement('span')
    glyph.className = `kbn-card-glyph ${isAgentCard(card) ? 'kbn-card-glyph-agent' : 'kbn-card-glyph-human'}`
    glyph.textContent = isAgentCard(card) ? '◐' : '✓'

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

    headerRow.append(glyph, name)
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

    // Actor + due row. Tag chips intentionally do not appear on the card
    // face; the detail modal remains the tag editing surface.
    const meta = document.createElement('div')
    meta.className = 'kbn-card-meta'

    const actor = document.createElement('span')
    actor.className = `kbn-card-actor ${isAgentCard(card) ? 'kbn-card-actor-agent' : 'kbn-card-actor-human'}`
    actor.textContent = isAgentCard(card) ? (card.shuttleAgent ?? 'agent') : 'me'
    meta.append(actor)

    if (card.due) {
      const due = document.createElement('span')
      due.className = 'kbn-card-due'
      due.textContent = `due ${formatDue(card.due)}`
      due.title = card.due
      meta.append(due)
    }

    if (card.drifted) {
      const drift = document.createElement('span')
      drift.className = 'kbn-card-drift'
      drift.textContent = '↑'
      drift.title = `Promoted from ${card.storedHorizon ?? 'unset'} by due date`
      meta.append(drift)
    }

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
      meta.append(reviewMetaActions)
    }

    // Running-worker pill: single-line, right-justified before the date,
    // sized like the inline review actions. Clickable: focuses the worker's
    // tmux session in kitty. The slug is already shown above, so the pill
    // just signals "a worker is up" rather than repeating the tmux session
    // name. "Aloft" picks up Portolan's bird metaphor (workers render as
    // bird sprites on the map).
    if (card.runningWorker) {
      const tmuxName = card.runningWorker
      const w = document.createElement('button')
      w.type = 'button'
      w.className = 'kbn-card-worker'
      w.setAttribute('aria-label', `Open worker terminal: ${tmuxName}`)
      w.title = `Worker aloft — click to open ${tmuxName} in kitty`
      w.textContent = '▸ aloft'
      w.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onOpenWorker?.(tmuxName)
      })
      meta.append(w)
    }
    el.append(meta)

    // Blocked indicator on in-flight cards with unsatisfied deps
    if (kind === 'inFlight' && !card.dependsOnSatisfied) {
      const block = document.createElement('div')
      block.className = 'kbn-card-blocked'
      block.textContent = `blocked on: ${(card.dependsOn ?? []).join(', ')}`
      el.append(block)
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

  /** POST endpoint for horizon edits, with `?cityId=` when scoped. */
  private horizonUrl(): string {
    const base = `${this.apiBase}/kanban/horizon`
    if (!this.cityScope) return base
    return `${base}?cityId=${encodeURIComponent(this.cityScope.cityId)}`
  }


  /** POST endpoint for review comments, with `?cityId=` when scoped. */
  private reviewCommentUrl(cityId: string | undefined): string {
    return cityId
      ? `${this.apiBase}/kanban/review-comment?cityId=${encodeURIComponent(cityId)}`
      : `${this.apiBase}/kanban/review-comment`
  }

  /** Scope cue only; global kanban does not need an implementation subtitle. */
  private subtitleText(): string {
    return this.cityScope?.cityName ?? ''
  }

  /** Bug 3: lightweight auto-poll while mounted. 15s interval. */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => {
      // Hidden tabs stop polling; visible but unfocused tiled windows slow
      // down to the shared page-attention cadence.
      if (!shouldRunVisiblePoll(this.lastFetchStartedAt, Date.now(), this.pollIntervalMs)) return
      void this.fetchAndRender()
    }, this.pollIntervalMs)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Update DOM that depends on `cityScope` after a scope swap. */
  private updateScopeChrome(): void {
    if (this.subtitleEl) this.subtitleEl.textContent = this.subtitleText()
    // The `⊕ Global` scope-escape button retired with the thumb-index
    // global-navigation constitution — scope flips no longer happen
    // in-place from inside the kanban tab.
  }

  /**
   * Shift+vertical wheel pans horizontally only if a scoped viewport ever
   * overflows sideways. Ordinary vertical wheel events stay native so row and
   * cell scrolling do not fight trackpads.
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
    if (this.body.scrollHeight <= this.body.clientHeight) return

    const rect = this.body.getBoundingClientRect()
    const edge = 96
    const maxStep = 34
    const topPressure = Math.max(0, edge - (e.clientY - rect.top))
    const bottomPressure = Math.max(0, edge - (rect.bottom - e.clientY))
    const direction = bottomPressure > 0 ? 1 : topPressure > 0 ? -1 : 0
    const pressure = Math.max(topPressure, bottomPressure) / edge

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

      this.body.scrollTop += this.dragAutoScrollVelocity
      this.updateBodyScrollAffordance()
      this.dragAutoScrollFrame = window.requestAnimationFrame(tick)
    }

    this.dragAutoScrollFrame = window.requestAnimationFrame(tick)
  }

  private stopDragAutoScroll(): void {
    // Every dragend / drop path in the modal funnels through here. Also
    // wind down the horizontal timeline edge-scroll so its rAF tick
    // doesn't keep running past the drag's lifetime.
    this.stopTimelineEdgeScroll()
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

    const requeueBtn = this.buildActionBtn('New session ▸', 'primary')
    requeueBtn.title = 'Dispatch a fresh worker; outcome preserved'

    const resumeBtn = this.buildActionBtn('Resume ▸', 'primary')
    resumeBtn.title = 'Try to resume the previous worker session; outcome preserved'
    const canResumePrevious = typeof card.sessionId === 'string' && card.sessionId.trim() !== ''
    if (!canResumePrevious) {
      resumeBtn.disabled = true
      resumeBtn.title = 'No previous worker session is recorded; start a new session instead'
      resumeBtn.setAttribute('aria-disabled', 'true')
    }

    const temperBtn = this.buildActionBtn('Temper', 'tempered')
    temperBtn.title = 'Close as tempered (human-accepted)'

    const compostBtn = this.buildActionBtn('Compost', 'composted')
    compostBtn.title = 'Close as composted (human-rejected)'

    actionsRow.append(requeueBtn, resumeBtn, temperBtn, compostBtn)

    requeueBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const message = messageTa.value.trim()
      const interactive = interactiveState.value
      const needsResumeTransition =
        card.shuttleKind === 'standing' && card.shuttleReviewState === 'awaiting'
      if (message === '' && !needsResumeTransition && !interactive) {
        // Empty message + autonomous + already dispatch-eligible -> immediate
        // dispatch, no review-comment needed.
        void this.runDispatchNow(card, requeueBtn, actionsErr, interactive)
      } else {
        // Non-empty message, interactive mode (we want it persisted on the
        // review-comment so the worker reads it), or standing role in
        // awaiting state (needs shuttle-ctl resume to transition state
        // while preserving outcome) -> runRequeue, which handles the
        // review-comment + optional state transition + dispatch.
        void this.runRequeue(card, message, 'fresh', scope, requeueBtn, actionsErr, interactive)
      }
    })
    resumeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!canResumePrevious) return
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

    void this.loadHistory(card.id, scope, historyList)
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

  /** URL helper for /kanban/dispatch-resume with cityScope. */
  private dispatchResumeUrl(cityId: string | undefined): string {
    return cityId
      ? `${this.apiBase}/kanban/dispatch-resume?cityId=${encodeURIComponent(cityId)}`
      : `${this.apiBase}/kanban/dispatch-resume`
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
    btn.textContent = mode === 'fresh' ? 'Starting…' : 'Resuming…'
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
        // Standing roles in awaiting state need a state transition before
        // dispatch — but the verb depends on the user's intent:
        //
        //   • Drag-to-tempered (elsewhere) → shuttle-ctl accept.
        //     Cycle advances, outcome cleared. The user is done with
        //     this run.
        //
        //   • Modal Resume / New Session buttons (this path) →
        //     shuttle-ctl resume. Cycle does NOT advance, outcome
        //     preserved. The user is NOT done — they want another
        //     worker on the same run, either continuing the same
        //     session (Resume) or starting fresh (New Session). The
        //     review-comment filed moments earlier carries the user's
        //     resume_mode; the daemon's check_resume_intent honors it
        //     on next dispatch.
        //
        // The previous accept-then-ad-hoc-dispatch path was wrong for
        // "I'm not done" intent: it wiped the outcome the user was
        // trying to talk to AND forced fresh (because accept clears
        // session.id and ad-hoc dispatch always starts fresh).
        if (card.shuttleReviewState === 'awaiting') {
          const resumeRes = await fetch(this.dispatchResumeUrl(cityId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fiberId: card.id }),
          })
          if (!resumeRes.ok) {
            const e = (await resumeRes.json().catch(() => ({}))) as { error?: string }
            throw new Error(e.error || `dispatch-resume ${resumeRes.status}`)
          }
          // shuttle-ctl resume set state=scheduled + next_due_at=now,
          // so the role is immediately due. We DON'T pass ad_hoc or
          // force here — letting the dispatcher take the
          // {:standing_run, run_id} prompt context (not :ad_hoc) so
          // resolve_resume_intent defers to check_resume_intent and
          // honors the user's resume_mode review-comment.
          await this.runDispatchNow(card, btn, errorEl, interactive, /* adHoc */ false)
          return
        }
        // Standing role NOT in awaiting state (scheduled, accepted) =
        // dormant in drafts. New Session should be ad-hoc so the cron slot
        // keeps its rhythm; Resume Previous must be force/non-ad-hoc so
        // Shuttle can honor resume_mode instead of forcing fresh.
        await this.runDispatchNow(
          card,
          btn,
          errorEl,
          interactive,
          mode === 'previous' ? false : undefined,
          mode === 'previous',
        )
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
      const dispatched = await this.runDispatchNow(card, btn, errorEl, interactive)
      if (!dispatched) {
        await this.rollbackFailedOneshotRequeue(card, cityId)
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      btn.disabled = false
      btn.textContent = original
    }
  }

  private async rollbackFailedOneshotRequeue(
    card: KanbanCard,
    cityId: string | undefined,
  ): Promise<void> {
    const res = await fetch(this.transitionUrl(cityId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiberId: card.id, target: 'awaitingReview' }),
    })
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error || `rollback ${res.status}`)
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
    /**
     * Override the ad_hoc flag. Defaults to undefined, which means
     * "ad_hoc=true for standing roles, ad_hoc=false for oneshots" — the
     * historical behavior. Pass `false` from the awaiting-resume path so
     * the dispatcher takes the {:standing_run, run_id} (non-:ad_hoc)
     * prompt context, letting check_resume_intent honor the user's
     * resume_mode review-comment.
     */
    adHoc?: boolean,
    force: boolean = false,
  ): Promise<boolean> {
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
    const dispatchFiberId = card.shuttleFiberId ?? card.id

    // Distinguish network failures (fetch never completed) from HTTP errors
    // (server responded). A TypeError from fetch means no response arrived —
    // CORS block, daemon not running, or network partition.
    let res: Response
    try {
      res = await fetch(`${shuttleBase}/api/v1/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiber_id: dispatchFiberId,
          // Default: ad_hoc=true for standing roles (manual triggers don't
          // consume scheduled slots). Resume-from-awaiting passes adHoc=false
          // explicitly so the dispatcher takes the resume-honoring path
          // rather than ad-hoc-forces-fresh.
          ...((adHoc ?? card.shuttleKind === 'standing') ? { ad_hoc: true } : {}),
          ...(force ? { force: true } : {}),
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
      return false
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
      return true
    }

    if (res.status === 422) {
      // not_eligible: the daemon knows why — not yet due, disabled, or closed.
      const humanReason = dispatchIneligibleReason(body.reason)
      this.showDispatchError(errorEl, btn, original, humanReason)
      return false
    }

    if (!res.ok) {
      // Daemon-side error (500 etc.) — surface whatever reason the body carries.
      const msg = body.reason ?? `Dispatch failed (${res.status})`
      this.showDispatchError(errorEl, btn, original, msg)
      return false
    }

    // 200 success — close the modal and refresh the kanban board.
    this.close()
    this.onSaved()
    return true
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

/** Skim-able title for surface affordance announcements. */
const SURFACE_TITLE: Record<HorizonKind, string> = {
  now: 'Now',
  soon: 'Soon',
  stashed: 'Stash',
}

const SECTION_COLLAPSED_STORAGE_KEY = 'portolan:kanban:collapsed-sections'

/** Read the persisted set of collapsed sections. Safe under SSR / private
 *  mode (no localStorage) — returns an empty set on any failure. */
function readSectionCollapsed(key: 'now' | 'timeline' | 'stash'): boolean {
  try {
    const raw = window.localStorage.getItem(SECTION_COLLAPSED_STORAGE_KEY)
    if (!raw) return false
    const set = new Set(JSON.parse(raw) as string[])
    return set.has(key)
  } catch {
    return false
  }
}

function writeSectionCollapsed(key: 'now' | 'timeline' | 'stash', collapsed: boolean): void {
  try {
    const raw = window.localStorage.getItem(SECTION_COLLAPSED_STORAGE_KEY)
    const set = new Set(raw ? (JSON.parse(raw) as string[]) : [])
    if (collapsed) set.add(key)
    else set.delete(key)
    window.localStorage.setItem(SECTION_COLLAPSED_STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // localStorage unavailable — silently no-op, the user will collapse again
    // next mount; nothing else depends on persistence.
  }
}

/** Format a Date as a stable YYYY-MM-DD ISO day. Timezone-aware (uses
 *  local midnight), so a card's due/closedAt rendered into a calendar
 *  column lands on the right local day. */
function isoDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

interface TimelineDay {
  iso: string
  label: string
  weekdayLabel: string
  isToday: boolean
  isPast: boolean
  isWeekend: boolean
  weekBoundary: boolean
}

function buildTimelineDays(past: number, future: number): TimelineDay[] {
  const days: TimelineDay[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let offset = -past; offset <= future; offset += 1) {
    const d = new Date(today.getTime() + offset * 86_400_000)
    const dow = d.getDay()
    days.push({
      iso: isoDay(d),
      label: String(d.getDate()),
      weekdayLabel: d.toLocaleDateString(undefined, { weekday: 'short' }),
      isToday: offset === 0,
      isPast: offset < 0,
      isWeekend: dow === 0 || dow === 6,
      // Week boundary marker: end of Sunday (so the visual rule lands
      // between Sunday and Monday).
      weekBoundary: dow === 0,
    })
  }
  return days
}

function buildDayCell(day: TimelineDay): HTMLElement {
  const el = document.createElement('div')
  const classes = ['kbn-timeline-day']
  if (day.isToday) classes.push('kbn-timeline-day-today')
  if (day.isPast) classes.push('kbn-timeline-day-past')
  if (day.isWeekend) classes.push('kbn-timeline-day-weekend')
  if (day.weekBoundary) classes.push('kbn-timeline-day-week-boundary')
  el.className = classes.join(' ')
  el.dataset.dayIso = day.iso

  const dow = document.createElement('span')
  dow.className = 'kbn-timeline-day-dow'
  dow.textContent = day.isToday ? 'today' : day.weekdayLabel
  const num = document.createElement('span')
  num.className = 'kbn-timeline-day-num'
  num.textContent = day.label
  el.append(dow, num)
  return el
}

/** Resolve an ISO-8601 timestamp to a column index within the timeline
 *  day map. Returns null when the timestamp falls outside the visible
 *  window or is malformed. */
function dayIndexForIso(
  iso: string | undefined,
  dayIndex: Map<string, number>,
): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return dayIndex.get(isoDay(d)) ?? null
}

/** Cluster stash cards by containment-path's first meaningful project
 *  token. Skips umbrella roots (CLUSTER_KEY_SKIP_ROOTS). Warm clusters
 *  are emitted before cold; within each warmth, clusters sort by
 *  most-recent-card descending (the empirical "what did I touch last?"
 *  ordering — beats alphabetical for retrieval). */
function clusterStashCards(stash: KanbanCard[]): StashCluster[] {
  const byKey = new Map<string, StashCluster>()
  for (const card of stash) {
    const key = stashClusterKey(card.id)
    const cold = card.cold === true
    const composite = `${key}::${cold ? 'cold' : 'warm'}`
    let cluster = byKey.get(composite)
    if (!cluster) {
      cluster = { key, cold, cards: [] }
      byKey.set(composite, cluster)
    }
    cluster.cards.push(card)
  }
  const out = [...byKey.values()]
  // Sort within cluster by createdAt desc, then sort clusters by
  // most-recent-touch desc (use the first card's createdAt after the
  // inner sort).
  for (const c of out) {
    c.cards.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }
  out.sort((a, b) => {
    if (a.cold !== b.cold) return a.cold ? 1 : -1
    const aT = a.cards[0]?.createdAt ?? ''
    const bT = b.cards[0]?.createdAt ?? ''
    return bT.localeCompare(aT)
  })
  return out
}

/** First meaningful project segment of a fiber id. Skips umbrella
 *  roots so `ai-futures/portolan/...` clusters under `portolan`.
 *  Falls back to the leaf when no segment passes the filter. */
function stashClusterKey(id: string): string {
  const segments = id.split('/').filter(Boolean)
  for (const seg of segments) {
    if (!CLUSTER_KEY_SKIP_ROOTS.has(seg)) return seg
  }
  return segments[segments.length - 1] ?? id
}

function isAgentCard(card: KanbanCard): boolean {
  return card.shuttleKind !== undefined ||
    card.shuttleAgent !== undefined ||
    card.shuttleEnabled !== undefined ||
    card.shuttleReviewState !== undefined ||
    card.shuttleFiberId !== undefined
}

function formatDue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

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
 * Find which Now-surface column the server has placed a card in, per
 * the last response. Used by the lifecycle drop handler to derive the
 * transition target. Returns null when the card lives outside the now
 * surface (or isn't in the response at all). Surface routing (now /
 * timeline / stash) is handled by `findCardSurface`.
 */
function findCardColumn(resp: KanbanResponse | null, id: string): ColumnKind | null {
  if (!resp) return null
  for (const kind of NOW_COLUMN_ORDER) {
    if (resp.now[kind].some((c) => c.id === id)) return kind
  }
  if (resp.ideas.some((c) => c.id === id)) return 'ideas'
  // Past landings are surfaced as tempered/composted via the card's
  // tempered field; the column placement still matches.
  for (const c of resp.timeline.past) {
    if (c.id === id) return c.tempered === false ? 'composted' : 'tempered'
  }
  return null
}

function findCardById(resp: KanbanResponse | null, id: string): KanbanCard | null {
  if (!resp) return null
  for (const kind of NOW_COLUMN_ORDER) {
    const hit = resp.now[kind].find((c) => c.id === id)
    if (hit) return hit
  }
  for (const list of [resp.timeline.past, resp.timeline.futureDated, resp.timeline.anytimeSoon, resp.stash, resp.ideas]) {
    const hit = list.find((c) => c.id === id)
    if (hit) return hit
  }
  return null
}

function normalizeKanbanResponse(raw: unknown): KanbanResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Kanban response was not an object')
  }

  const data = raw as LegacyKanbanResponse
  if (!isRecord(data.now) && !isRecord(data.columns)) {
    throw new Error('Kanban response missing board columns')
  }

  const nowSource: Record<string, unknown> = isRecord(data.now) ? data.now : {}
  const legacyColumns: Record<string, unknown> = isRecord(data.columns) ? data.columns : {}
  const timelineSource: Record<string, unknown> = isRecord(data.timeline) ? data.timeline : {}
  const past = listFrom<KanbanCard>(
    timelineSource['past'],
    ...listFrom<KanbanCard>(legacyColumns['tempered']),
    ...listFrom<KanbanCard>(legacyColumns['composted']),
  )
  const now = {
    drafts: listFrom<KanbanCard>(nowSource['drafts'], ...listFrom<KanbanCard>(legacyColumns['drafts'])),
    inFlight: listFrom<KanbanCard>(nowSource['inFlight'], ...listFrom<KanbanCard>(legacyColumns['inFlight'])),
    awaitingReview: listFrom<KanbanCard>(nowSource['awaitingReview'], ...listFrom<KanbanCard>(legacyColumns['awaitingReview'])),
  }
  const timeline = {
    past,
    futureDated: listFrom<KanbanCard>(timelineSource['futureDated']),
    anytimeSoon: listFrom<KanbanCard>(timelineSource['anytimeSoon']),
  }
  const stash = listFrom<KanbanCard>(data.stash)
  const ideas = listFrom<KanbanCard>(data.ideas, ...listFrom<KanbanCard>(legacyColumns['ideas']))
  const totalsSource: Record<string, unknown> = isRecord(data.totals) ? data.totals : {}
  const staleness =
    isRecord(data.staleness)
      ? data.staleness as Record<string, KanbanOriginStaleness>
      : { local: { status: 'fresh' as const } }

  return {
    feltHost: typeof data.feltHost === 'string' ? data.feltHost : '',
    now,
    timeline,
    stash,
    ideas,
    totals: {
      ideas: numeric(totalsSource['ideas'], ideas.length),
      drafts: numeric(totalsSource['drafts'], now.drafts.length),
      inFlight: numeric(totalsSource['inFlight'], now.inFlight.length),
      awaitingReview: numeric(totalsSource['awaitingReview'], now.awaitingReview.length),
      past: numeric(totalsSource['past'], timeline.past.length),
      futureDated: numeric(totalsSource['futureDated'], timeline.futureDated.length),
      anytimeSoon: numeric(totalsSource['anytimeSoon'], timeline.anytimeSoon.length),
      stash: numeric(totalsSource['stash'], stash.length),
    },
    temperedTotal: numeric(
      data.temperedTotal,
      timeline.past.filter((card) => card.tempered === true).length,
    ),
    staleness,
    shuttleDiagnostics: {
      remoteSnapshots: listFrom(data.shuttleDiagnostics?.remoteSnapshots),
    },
    remoteScope: data.remoteScope,
    tagIndex: listFrom(data.tagIndex).filter((tag): tag is string => typeof tag === 'string'),
    generatedAt: numeric(data.generatedAt, Date.now()),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function listFrom<T = any>(value: unknown, ...fallback: T[]): T[] {
  return Array.isArray(value) ? value as T[] : fallback
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function remoteDisconnectedText(
  data: KanbanResponse,
  state: KanbanOriginStaleness,
): string {
  const hostname = data.remoteScope?.hostname ?? state.hostname ?? 'remote'
  const totals = data.totals
  const hasCards =
    totals.ideas + totals.drafts + totals.inFlight +
    totals.awaitingReview + totals.past + totals.futureDated +
    totals.anytimeSoon + totals.stash > 0
  return hasCards
    ? `Remote city ${hostname} disconnected; showing last snapshot · `
    : `Remote city ${hostname} disconnected; no Kanban snapshot yet · `
}

function shuttleDiagnosticsSignature(
  diagnostics: KanbanResponse['shuttleDiagnostics'] | undefined,
): Array<Pick<RemoteShuttleSnapshotDiagnostic, 'originId' | 'receivedAt' | 'eligibleCount' | 'blockedCount' | 'orphanCount'>> {
  return (diagnostics?.remoteSnapshots ?? [])
    .map(({ originId, receivedAt, eligibleCount, blockedCount, orphanCount }) => ({
      originId,
      receivedAt,
      eligibleCount,
      blockedCount,
      orphanCount,
    }))
    .sort((a, b) => a.originId.localeCompare(b.originId))
}

function formatRemoteShuttleDiagnostics(
  diagnostics: KanbanResponse['shuttleDiagnostics'] | undefined,
): string {
  const snapshots = diagnostics?.remoteSnapshots ?? []
  if (snapshots.length === 0) return ''

  return snapshots
    .slice()
    .sort((a, b) => a.originId.localeCompare(b.originId))
    .map((entry) => {
      const host = entry.originId.replace(/^remote-/, '')
      const eligible = entry.eligibleCount ?? '?'
      const blocked = entry.blockedCount ?? '?'
      const orphan = entry.orphanCount ?? '?'
      const age = formatRelative(entry.receivedAt)
      const suffix = age ? ` @ ${age}` : ''
      return `Shuttle ${host}: ${eligible}/${blocked}/${orphan}${suffix}`
    })
    .join(' · ')
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
