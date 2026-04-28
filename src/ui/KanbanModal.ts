/**
 * KanbanModal — global view of constitution-tagged fibers grouped by lifecycle.
 *
 * Three columns (left to right): Awaiting review → In flight → Tempered.
 *   - Awaiting review  : closed && !tempered. The "your move" queue.
 *   - In flight        : status open/active (dispatchable; Shuttle picks them up).
 *   - Tempered         : closed && tempered:true (recent N, de-emphasized).
 *
 * Awaiting-review is leftmost and slightly emphasized — that's the human-action
 * column. Tempered is narrower and more compact since it's "for the record."
 *
 * Interaction surfaces (the same transition is available two ways):
 *   1. Drag a card to a column (HTML5 DnD; mouse-driven).
 *   2. Click a transition button on the card (keyboard + a11y-tree-driven).
 *      Each card carries explicit "Move to X" buttons for the columns it
 *      isn't currently in. This is the primary path for agent-browser
 *      snapshot tests: the buttons appear in the a11y tree with stable
 *      aria-labels regardless of mouse hover state.
 *
 * Both surfaces POST to /kanban/transition with {fiberId, target}. The card
 * is moved optimistically, then the kanban refetches to reconcile. Errors
 * surface as a transient banner inside the modal and roll the optimistic
 * change back.
 *
 * Click anywhere on the card body (not on action buttons or drag handles)
 * → opens the fiber's md in vellum.
 *
 * Hotkey: `k` (registered in main.ts).
 */
import { lockModalBackground } from './modalBackgroundLock'

/** Column identifier — also doubles as the API target. */
type ColumnKind = 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered'

const COLUMN_TITLES: Record<ColumnKind, string> = {
  drafts: 'Drafts',
  inFlight: 'In flight',
  awaitingReview: 'Awaiting review',
  tempered: 'Tempered',
}

const COLUMN_BLURBS: Record<ColumnKind, string> = {
  drafts: 'Brainstorming. Tagged constitution+draft. Refine until ready, then promote.',
  inFlight: 'Constitution-tagged, not closed. Workers running show ▸; otherwise queued.',
  awaitingReview: 'Your move — agent flipped the fiber to closed.',
  tempered: 'Recent — accepted by Cail.',
}

/**
 * All transitions a card has from its current column.
 * Order is which buttons to render first — usually "forward" first.
 */
const TRANSITIONS_FROM: Record<ColumnKind, ColumnKind[]> = {
  drafts: ['inFlight'],
  inFlight: ['awaitingReview', 'drafts'],
  awaitingReview: ['tempered', 'inFlight'],
  tempered: ['awaitingReview', 'inFlight'],
}

/** Short label for action buttons, in verb form. */
function actionLabel(target: ColumnKind): string {
  switch (target) {
    case 'drafts': return 'Send to drafts'
    case 'inFlight': return 'Promote'
    case 'tempered': return 'Approve'
    case 'awaitingReview': return 'Mark for review'
  }
}

interface KanbanCard {
  id: string
  name: string
  path: string
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
}

interface KanbanResponse {
  feltHost: string
  columns: {
    drafts: KanbanCard[]
    inFlight: KanbanCard[]
    awaitingReview: KanbanCard[]
    tempered: KanbanCard[]
  }
  totals: { drafts: number; inFlight: number; awaitingReview: number; tempered: number }
  temperedTotal: number
  generatedAt: number
}

interface KanbanModalOptions {
  /** Called when the user activates a card — host opens the fiber's md in vellum. */
  onOpenFiber: (card: KanbanCard) => void
  /** Override fetch base. Defaults to `http://${hostname}:4004`. */
  apiBase?: string
}

export class KanbanModal {
  private readonly onOpenFiber: (card: KanbanCard) => void
  private readonly apiBase: string

  private container: HTMLDivElement | null = null
  private scrim: HTMLDivElement | null = null
  private body: HTMLDivElement | null = null
  private statusEl: HTMLDivElement | null = null
  private liveEl: HTMLDivElement | null = null
  private bannerEl: HTMLDivElement | null = null
  private unlockBackground: (() => void) | null = null
  private visible = false
  private inflightFetchToken = 0
  private dragSourceId: string | null = null
  private bannerTimer: number | null = null

  constructor(options: KanbanModalOptions) {
    this.onOpenFiber = options.onOpenFiber
    this.apiBase = options.apiBase ?? `http://${window.location.hostname}:4004`
    this.injectStyles()
  }

  isVisible(): boolean {
    return this.visible
  }

  show(): void {
    if (this.visible) return
    this.visible = true
    this.mount()
    this.unlockBackground = lockModalBackground(this.container!)
    this.fetchAndRender()
    document.addEventListener('keydown', this.onKeydown, true)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    document.removeEventListener('keydown', this.onKeydown, true)
    this.unlockBackground?.()
    this.unlockBackground = null
    this.scrim?.remove()
    this.container?.remove()
    this.scrim = null
    this.container = null
    this.body = null
    this.statusEl = null
    this.liveEl = null
    this.bannerEl = null
    this.dragSourceId = null
    if (this.bannerTimer !== null) {
      window.clearTimeout(this.bannerTimer)
      this.bannerTimer = null
    }
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  // ---------------------------------------------------------------------------

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // Capture phase + stopImmediatePropagation: this modal owns Escape while open.
      event.preventDefault()
      event.stopImmediatePropagation()
      this.hide()
      return
    }
    // `r` reloads the kanban (cheap and useful while iterating)
    if (event.key === 'r' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      event.preventDefault()
      void this.fetchAndRender()
    }
  }

  private mount(): void {
    this.scrim = document.createElement('div')
    this.scrim.className = 'kbn-scrim'
    this.scrim.addEventListener('click', () => this.hide())

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
    const subtitle = document.createElement('div')
    subtitle.className = 'kbn-subtitle'
    subtitle.textContent = 'constitution-tagged fibers'

    const titleWrap = document.createElement('div')
    titleWrap.className = 'kbn-title-wrap'
    titleWrap.append(title, subtitle)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'kbn-status'
    this.statusEl.textContent = 'Loading…'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'kbn-close'
    closeBtn.setAttribute('aria-label', 'Close kanban')
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', () => this.hide())

    header.append(titleWrap, this.statusEl, closeBtn)

    this.body = document.createElement('div')
    this.body.className = 'kbn-body'

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
    document.body.append(this.scrim, this.container)
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
      const res = await fetch(`${this.apiBase}/kanban/transition`, {
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
      const res = await fetch(`${this.apiBase}/kanban`)
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

    const { columns, totals, temperedTotal } = data
    this.statusEl.textContent =
      `${totals.drafts} drafts · ${totals.inFlight} in flight · ` +
      `${totals.awaitingReview} awaiting review · ${totals.tempered}/${temperedTotal} tempered`

    this.body.innerHTML = ''
    // Workflow order, left to right: idea → committed work → review → archive.
    this.body.append(
      this.renderColumn('drafts', columns.drafts),
      this.renderColumn('inFlight', columns.inFlight),
      this.renderColumn('awaitingReview', columns.awaitingReview),
      this.renderColumn('tempered', columns.tempered, temperedTotal),
    )
  }

  /**
   * Render one column. Supports drag-and-drop as a drop target with visual
   * feedback. The list element carries role="list" and each card carries
   * role="listitem" so the a11y tree shows a structured "X cards in Y column"
   * shape that agent-browser's snapshot can navigate cleanly.
   */
  private renderColumn(kind: ColumnKind, cards: KanbanCard[], temperedTotal?: number): HTMLElement {
    const title = COLUMN_TITLES[kind]
    const col = document.createElement('section')
    col.className = `kbn-col kbn-col-${kind}`
    col.setAttribute('role', 'region')
    col.setAttribute('aria-label', `${title} (${cards.length})`)
    col.dataset.column = kind

    const head = document.createElement('div')
    head.className = 'kbn-col-head'
    const headTitle = document.createElement('h2')
    headTitle.className = 'kbn-col-title'
    headTitle.textContent = title
    const headCount = document.createElement('span')
    headCount.className = 'kbn-col-count'
    headCount.textContent = kind === 'tempered' && temperedTotal !== undefined
      ? `${cards.length}/${temperedTotal}`
      : String(cards.length)
    head.append(headTitle, headCount)

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
        list.append(this.renderCard(card, kind))
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
   */
  private renderCard(card: KanbanCard, kind: ColumnKind): HTMLElement {
    const el = document.createElement('div')
    el.className = `kbn-card kbn-card-${kind}`
    el.setAttribute('role', 'listitem')
    el.setAttribute('aria-label', `${card.name} — ${COLUMN_TITLES[kind]}`)
    el.draggable = true
    el.dataset.fiberId = card.id

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

    // Header row: name + status pill (+ drag-handle hint)
    const headerRow = document.createElement('div')
    headerRow.className = 'kbn-card-header'

    const dragHandle = document.createElement('span')
    dragHandle.className = 'kbn-card-handle'
    dragHandle.setAttribute('aria-hidden', 'true')
    dragHandle.title = 'Drag to move'
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

    // Action buttons — one per available transition. Always visible so they
    // appear in agent-browser snapshots without a hover state.
    const actions = document.createElement('div')
    actions.className = 'kbn-card-actions'
    actions.setAttribute('role', 'group')
    actions.setAttribute('aria-label', `Move actions for ${card.name}`)

    for (const target of TRANSITIONS_FROM[kind]) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `kbn-action kbn-action-${target}`
      btn.dataset.target = target
      btn.dataset.fiberId = card.id
      const verb = actionLabel(target)
      btn.textContent = verb
      btn.setAttribute(
        'aria-label',
        `${verb} — move “${card.name}” to ${COLUMN_TITLES[target]}`,
      )
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.transition(card, target)
      })
      actions.append(btn)
    }
    el.append(actions)

    // Blocked indicator on in-flight cards with unsatisfied deps
    if (kind === 'inFlight' && !card.dependsOnSatisfied) {
      const block = document.createElement('div')
      block.className = 'kbn-card-blocked'
      block.textContent = `blocked on: ${(card.dependsOn ?? []).join(', ')}`
      el.append(block)
    }

    // Running-worker indicator on active cards.
    if (card.runningWorker) {
      const w = document.createElement('div')
      w.className = 'kbn-card-worker'
      w.setAttribute('aria-label', `Shuttle worker running: ${card.runningWorker}`)
      w.textContent = `▸ ${card.runningWorker}`
      el.append(w)
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

  private pillKind(card: KanbanCard): 'open' | 'active' | 'closed' | 'tempered' {
    if (card.tempered === true) return 'tempered'
    if (card.status === 'closed') return 'closed'
    if (card.status === 'active') return 'active'
    return 'open'
  }

  private pillLabel(card: KanbanCard): string {
    if (card.tempered === true) return 'tempered'
    return card.status || 'open'
  }

  // ---------------------------------------------------------------------------

  private injectStyles(): void {
    if (document.getElementById('kbn-styles')) return
    const style = document.createElement('style')
    style.id = 'kbn-styles'
    style.textContent = `
      .kbn-scrim {
        position: fixed; inset: 0;
        background: rgba(46, 42, 38, 0.45);
        z-index: 9000;
        backdrop-filter: blur(2px);
      }
      .kbn-modal {
        position: fixed;
        top: 5vh; left: 5vw;
        width: 90vw; height: 90vh;
        background: #EDE8E0;
        border: 1px solid rgba(46, 42, 38, 0.18);
        border-radius: 4px;
        box-shadow: 0 12px 48px rgba(46, 42, 38, 0.35);
        z-index: 9001;
        display: flex; flex-direction: column;
        font-family: var(--font-main, 'EB Garamond', serif);
        color: #2E2A26;
        overflow: hidden;
      }
      .kbn-header {
        display: flex; align-items: baseline; gap: 16px;
        padding: 14px 20px;
        border-bottom: 1px solid rgba(46, 42, 38, 0.12);
        background: #E5DED2;
        flex-shrink: 0;
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
      .kbn-close {
        background: transparent;
        border: none;
        font-size: 28px;
        line-height: 1;
        color: #7A7068;
        cursor: pointer;
        padding: 0 8px;
        border-radius: 2px;
        transition: color 120ms ease, background 120ms ease;
      }
      .kbn-close:hover {
        color: #2E2A26;
        background: rgba(46, 42, 38, 0.08);
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
      .kbn-body {
        flex: 1;
        /* drafts (quiet), in-flight, awaiting (your-move, slightly wider), tempered (record). */
        display: grid;
        grid-template-columns: 1fr 1fr 1.15fr 0.8fr;
        gap: 10px;
        padding: 12px;
        overflow: hidden;
        min-height: 0;
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
      }
      @keyframes kbn-pulse {
        0%, 100% { background: rgba(90, 123, 123, 0.10); }
        50% { background: rgba(90, 123, 123, 0.22); }
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
        .kbn-body { grid-template-columns: 1fr; overflow-y: auto; }
        .kbn-col { max-height: none; }
      }
    `
    document.head.append(style)
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Which column the card belongs to per the same rules the server uses. */
function columnOf(card: KanbanCard): ColumnKind {
  if (card.status === 'closed') {
    return card.tempered === true ? 'tempered' : 'awaitingReview'
  }
  if (card.tags?.includes('draft')) return 'drafts'
  return 'inFlight'
}

function findCardById(resp: KanbanResponse | null, id: string): KanbanCard | null {
  if (!resp) return null
  for (const col of [resp.columns.drafts, resp.columns.inFlight, resp.columns.awaitingReview, resp.columns.tempered]) {
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
