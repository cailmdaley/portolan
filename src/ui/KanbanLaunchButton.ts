/**
 * KanbanLaunchButton — small fixed icon at top-left, perches alongside the
 * RecentWorkerBar's bird wire. Click to open the KanbanModal.
 *
 * Visual: three vertical strokes in the porch-morning ink palette, suggesting
 * kanban columns. Same height as the bird perches (16px-ish), same subdued
 * ink-faded tint.
 *
 * Polls `/kanban` every 30s when idle to surface the awaiting-review count
 * as a small badge — the primary "your move" signal for the human. Skips
 * the badge update while the modal is open (the modal itself shows fresh
 * counts).
 */

interface KanbanLaunchButtonOptions {
  onOpen: () => void
  /** Override fetch base. Defaults to `http://${hostname}:4004`. */
  apiBase?: string
  /** Should the button skip its background poll (e.g. modal is open). */
  isModalOpen?: () => boolean
  pollIntervalMs?: number
}

export class KanbanLaunchButton {
  private readonly onOpen: () => void
  private readonly apiBase: string
  private readonly isModalOpen?: () => boolean
  private readonly pollIntervalMs: number

  private root: HTMLButtonElement
  private badge: HTMLSpanElement
  private pollTimer: number | null = null
  private lastBadgeValue: number | null = null

  constructor(options: KanbanLaunchButtonOptions) {
    this.onOpen = options.onOpen
    this.apiBase = options.apiBase ?? `http://${window.location.hostname}:4004`
    this.isModalOpen = options.isModalOpen
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000

    this.injectStyles()

    this.root = document.createElement('button')
    this.root.type = 'button'
    this.root.className = 'kbn-launch'
    this.root.setAttribute('aria-label', 'Open kanban (k)')
    this.root.title = 'Kanban (press k)'
    this.root.addEventListener('click', () => this.onOpen())

    const icon = document.createElement('span')
    icon.className = 'kbn-launch-icon'
    icon.setAttribute('aria-hidden', 'true')
    // Three vertical strokes — kanban columns
    icon.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none">' +
      '<line x1="3" y1="3" x2="3" y2="13"/>' +
      '<line x1="8" y1="5" x2="8" y2="13"/>' +
      '<line x1="13" y1="3" x2="13" y2="13"/>' +
      '</svg>'

    this.badge = document.createElement('span')
    this.badge.className = 'kbn-launch-badge'
    this.badge.style.display = 'none'

    this.root.append(icon, this.badge)
    document.body.append(this.root)

    void this.refreshBadge()
    this.startPolling()
  }

  /** Manually refresh the badge — host calls after modal close, etc. */
  refreshSoon(): void {
    void this.refreshBadge()
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.root.remove()
  }

  // ---------------------------------------------------------------------------

  private startPolling(): void {
    this.pollTimer = window.setInterval(() => {
      if (this.isModalOpen?.()) return
      void this.refreshBadge()
    }, this.pollIntervalMs)
  }

  private async refreshBadge(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/kanban`)
      if (!res.ok) return
      const data = await res.json() as { totals?: { awaitingReview?: number } }
      const n = data.totals?.awaitingReview ?? 0
      if (n === this.lastBadgeValue) return
      this.lastBadgeValue = n
      if (n > 0) {
        this.badge.textContent = n > 99 ? '99+' : String(n)
        this.badge.style.display = ''
      } else {
        this.badge.style.display = 'none'
      }
    } catch {
      // Silent — the badge is a hint, not a contract.
    }
  }

  private injectStyles(): void {
    if (document.getElementById('kbn-launch-styles')) return
    const style = document.createElement('style')
    style.id = 'kbn-launch-styles'
    style.textContent = `
      .kbn-launch {
        position: fixed;
        top: 10px;
        left: 14px;
        z-index: 51; /* above .rwb-bar (50) so it always reads as a control */
        height: 36px;
        width: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 3px;
        color: #7A7068;
        cursor: pointer;
        padding: 0;
        transition: color 150ms ease, border-color 150ms ease, background 150ms ease;
      }
      .kbn-launch:hover {
        color: #2E2A26;
        border-color: rgba(46, 42, 38, 0.18);
        background: rgba(237, 232, 224, 0.7);
      }
      .kbn-launch:focus { outline: none; }
      .kbn-launch:focus-visible {
        outline: 1px dashed #7A7068;
        outline-offset: 2px;
      }
      .kbn-launch-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .kbn-launch-badge {
        position: absolute;
        top: 2px;
        right: 2px;
        min-width: 14px;
        height: 14px;
        padding: 0 3px;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 9.5px;
        line-height: 14px;
        text-align: center;
        background: #9A7B35;
        color: #FBF7F0;
        border-radius: 7px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
    `
    document.head.append(style)
  }
}
