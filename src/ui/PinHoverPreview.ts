// PinHoverPreview.ts — extended-hover tooltip for map-pinned vellum cards.
//
// Milestone of fiber `tapestry-dissolves`: after ~550ms of hover on a pinned
// card, a small parchment tooltip fades in with the fiber's title + lede.
// Gives the user a glance-level answer ("what is this pin about") before
// committing to a click — the spatial map stays uncluttered by default.

export interface PinHoverInfo {
  title: string
  lede: string
  status?: string
}

export interface PinHoverPreviewOptions {
  /** Resolve the tooltip content for a slug. Return null to skip showing. */
  infoFor: (slug: string) => PinHoverInfo | null
}

const HOVER_DELAY_MS = 550
const ANCHOR_OFFSET_Y = 18

export class PinHoverPreview {
  private readonly el: HTMLDivElement
  private readonly infoFor: (slug: string) => PinHoverInfo | null
  private activeSlug: string | null = null
  private showTimer: number | null = null

  constructor(opts: PinHoverPreviewOptions) {
    this.infoFor = opts.infoFor
    this.el = document.createElement('div')
    this.el.className = 'pin-hover-preview'
    this.el.style.display = 'none'
    document.body.appendChild(this.el)
  }

  /** Update hover state. Pass null/null to clear. */
  setHover(slug: string | null, anchor: { x: number; y: number } | null): void {
    if (!slug || !anchor) {
      this.hide()
      return
    }
    if (slug === this.activeSlug) {
      this.position(anchor)
      return
    }
    this.activeSlug = slug
    this.clearTimer()
    this.el.style.display = 'none'
    const pending = slug
    const pendingAnchor = { ...anchor }
    this.showTimer = window.setTimeout(() => {
      this.showTimer = null
      if (this.activeSlug !== pending) return
      const info = this.infoFor(pending)
      if (!info) return
      this.paint(info)
      this.position(pendingAnchor)
      this.el.style.display = 'block'
    }, HOVER_DELAY_MS)
  }

  hide(): void {
    this.clearTimer()
    this.activeSlug = null
    this.el.style.display = 'none'
  }

  private clearTimer(): void {
    if (this.showTimer !== null) {
      window.clearTimeout(this.showTimer)
      this.showTimer = null
    }
  }

  private paint(info: PinHoverInfo): void {
    const titleEl = document.createElement('div')
    titleEl.className = 'pin-hover-preview-title'
    titleEl.textContent = info.title
    const ledeEl = document.createElement('div')
    ledeEl.className = 'pin-hover-preview-lede'
    ledeEl.textContent = info.lede
    this.el.replaceChildren(titleEl, ledeEl)
  }

  private position(anchor: { x: number; y: number }): void {
    const width = this.el.offsetWidth || 280
    const height = this.el.offsetHeight || 80
    const margin = 8
    let left = anchor.x - width / 2
    let top = anchor.y + ANCHOR_OFFSET_Y
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (left + width + margin > vw) left = vw - width - margin
    if (left < margin) left = margin
    if (top + height + margin > vh) top = anchor.y - height - ANCHOR_OFFSET_Y
    if (top < margin) top = margin
    this.el.style.left = `${left}px`
    this.el.style.top = `${top}px`
  }
}
