/**
 * KanbanModal — global view of constitution-tagged fibers grouped by lifecycle.
 *
 * Three columns:
 *   - In flight        : status open/active (dispatchable; would be picked up by Shuttle)
 *   - Awaiting review  : closed && !tempered (agent paused, your move)
 *   - Tempered         : closed && tempered:true (recent N)
 *
 * The middle column is the action queue. Most readings of this UI are looking
 * for "what does Cail need to temper?" — that column comes first visually and
 * gets a subtle highlight.
 *
 * Read-only v0. Click a card → opens the fiber's md in vellum via the host
 * `onOpenFiber` callback. Tempering happens via CLI (felt edit / direct
 * frontmatter) for now.
 *
 * Source: GET /kanban → KanbanResponse (server/src/HttpApiKanban.ts).
 *
 * Hotkey: `k` (registered in main.ts).
 * A button in the top bar (KanbanLaunchButton) also opens it.
 */
import { lockModalBackground } from './modalBackgroundLock'

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
}

interface KanbanResponse {
  feltHost: string
  columns: {
    inFlight: KanbanCard[]
    awaitingReview: KanbanCard[]
    tempered: KanbanCard[]
  }
  totals: { inFlight: number; awaitingReview: number; tempered: number }
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
  private unlockBackground: (() => void) | null = null
  private visible = false
  private inflightFetchToken = 0

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

    this.container.append(header, this.body)
    document.body.append(this.scrim, this.container)
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
      `${totals.inFlight} in flight · ${totals.awaitingReview} awaiting review · ` +
      `${totals.tempered}/${temperedTotal} tempered`

    this.body.innerHTML = ''
    this.body.append(
      this.renderColumn('Awaiting review', 'awaiting', columns.awaitingReview, 'Your move — agent flipped the fiber to closed.'),
      this.renderColumn('In flight', 'inflight', columns.inFlight, 'Status open or active. Constitution-tagged work, dispatchable by Shuttle.'),
      this.renderColumn('Tempered', 'tempered', columns.tempered, `Recent ${columns.tempered.length} of ${temperedTotal} accepted by Cail.`),
    )
  }

  private renderColumn(title: string, kind: 'awaiting' | 'inflight' | 'tempered', cards: KanbanCard[], blurb: string): HTMLElement {
    const col = document.createElement('section')
    col.className = `kbn-col kbn-col-${kind}`
    col.setAttribute('aria-label', `${title} (${cards.length})`)

    const head = document.createElement('div')
    head.className = 'kbn-col-head'
    const headTitle = document.createElement('div')
    headTitle.className = 'kbn-col-title'
    headTitle.textContent = title
    const headCount = document.createElement('span')
    headCount.className = 'kbn-col-count'
    headCount.textContent = String(cards.length)
    head.append(headTitle, headCount)

    const blurbEl = document.createElement('div')
    blurbEl.className = 'kbn-col-blurb'
    blurbEl.textContent = blurb

    const list = document.createElement('div')
    list.className = 'kbn-col-list'

    if (cards.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-empty'
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

  private renderCard(card: KanbanCard, kind: 'awaiting' | 'inflight' | 'tempered'): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `kbn-card kbn-card-${kind}`
    el.setAttribute('aria-label', `Open fiber ${card.name}`)
    el.addEventListener('click', () => {
      this.onOpenFiber(card)
    })

    // Header row: name + status pill
    const headerRow = document.createElement('div')
    headerRow.className = 'kbn-card-header'

    const name = document.createElement('div')
    name.className = 'kbn-card-name'
    name.textContent = card.name

    const pill = document.createElement('span')
    pill.className = `kbn-pill kbn-pill-${this.pillKind(card)}`
    pill.textContent = this.pillLabel(card)

    headerRow.append(name, pill)
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

    // Footer: tags + date
    const footer = document.createElement('div')
    footer.className = 'kbn-card-footer'

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

    footer.append(tagWrap, date)
    el.append(footer)

    // Blocked indicator on in-flight cards with unsatisfied deps
    if (kind === 'inflight' && !card.dependsOnSatisfied) {
      const block = document.createElement('div')
      block.className = 'kbn-card-blocked'
      block.textContent = `blocked on: ${(card.dependsOn ?? []).join(', ')}`
      el.append(block)
    }

    return el
  }

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
      .kbn-body {
        flex: 1;
        display: grid;
        grid-template-columns: 1.2fr 1fr 1fr;
        gap: 12px;
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
      }
      .kbn-col-awaiting {
        border-color: rgba(154, 123, 53, 0.55);
        box-shadow: inset 0 0 0 1px rgba(154, 123, 53, 0.18);
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
        cursor: pointer;
        font-family: inherit;
        color: inherit;
        display: flex; flex-direction: column;
        gap: 6px;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
      }
      .kbn-card:hover {
        background: #FFFCF6;
        border-color: rgba(46, 42, 38, 0.22);
        transform: translateY(-1px);
      }
      .kbn-card:focus-visible {
        outline: 1px dashed #7A7068;
        outline-offset: 2px;
      }
      .kbn-card-awaiting {
        border-color: rgba(154, 123, 53, 0.45);
      }
      .kbn-card-header {
        display: flex; align-items: flex-start; gap: 8px;
      }
      .kbn-card-name {
        flex: 1;
        font-size: 14.5px;
        font-weight: 600;
        line-height: 1.25;
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
      .kbn-card-footer {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
        margin-top: 2px;
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
