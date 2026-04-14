// PinHoverPreview.ts — extended-hover tooltip for map-pinned vellum cards.
//
// Milestone of fiber `tapestry-dissolves`: after ~550ms of hover on a pinned
// card, vellum's FiberCard fades in with the fiber's title, outcome, and
// tags — the same primitive the reader uses, rendered in tooltip scale so
// the map previews what opening the pin would show.
//
// The tooltip mounts a React island via `mountVellumFiberCardPreview` from
// the portolan vellum seam; see [[map-pinned-card-is-canvas-texture-not-dom]]
// for why the map-pinned card itself stays a three.js CanvasTexture while the
// hover preview can adopt vellum's DOM Card primitive.

import type { FiberContent, GraphNode } from 'vellum'
import {
  mountVellumFiberCardPreview,
  type FiberCardPreviewHandle,
} from '../vellum/mount'

export interface PinHoverPreviewOptions {
  /** Resolve a GraphNode for a slug. Return null to skip showing. */
  nodeFor: (slug: string) => GraphNode | null
  /** Optional city/origin context threaded into the adapter. */
  cityIdFor?: () => string | undefined
  originIdFor?: () => string | undefined
  /** Card width in px — drives FiberCard's pretext line wrapping. */
  width?: number
}

const HOVER_DELAY_MS = 550
const ANCHOR_OFFSET_Y = 18
const DEFAULT_WIDTH = 300

export class PinHoverPreview {
  private readonly el: HTMLDivElement
  private readonly nodeFor: (slug: string) => GraphNode | null
  private readonly cityIdFor?: () => string | undefined
  private readonly originIdFor?: () => string | undefined
  private readonly width: number
  private activeSlug: string | null = null
  private showTimer: number | null = null
  private handle: FiberCardPreviewHandle | null = null
  private mountedForCity: string | undefined = undefined
  private contentCache = new Map<string, FiberContent>()

  constructor(opts: PinHoverPreviewOptions) {
    this.nodeFor = opts.nodeFor
    this.cityIdFor = opts.cityIdFor
    this.originIdFor = opts.originIdFor
    this.width = opts.width ?? DEFAULT_WIDTH
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
      const node = this.nodeFor(pending)
      if (!node) return
      this.ensureHandle()
      const cached = this.contentCache.get(pending) ?? null
      this.handle!.update(node, this.width, cached)
      this.el.style.display = 'block'
      // Position after React commits so measured offsetWidth/Height are valid.
      requestAnimationFrame(() => {
        if (this.activeSlug === pending) this.position(pendingAnchor)
      })
      // If we don't yet have the prose body for this slug, fetch and re-render
      // so the lede paragraph appears below the pretext lockup. The pretext-only
      // variant stays as the first paint so the tooltip feels instant.
      if (!cached) {
        this.handle!.fetchContent(pending).then((content) => {
          if (!content) return
          this.contentCache.set(pending, content)
          if (this.activeSlug !== pending || !this.handle) return
          this.handle.update(node, this.width, content)
          requestAnimationFrame(() => {
            if (this.activeSlug === pending) this.position(pendingAnchor)
          })
        })
      }
    }, HOVER_DELAY_MS)
  }

  hide(): void {
    this.clearTimer()
    this.activeSlug = null
    this.el.style.display = 'none'
    if (this.handle) this.handle.update(null)
  }

  private clearTimer(): void {
    if (this.showTimer !== null) {
      window.clearTimeout(this.showTimer)
      this.showTimer = null
    }
  }

  private ensureHandle(): void {
    const cityId = this.cityIdFor?.()
    if (this.handle && this.mountedForCity === cityId) return
    if (this.handle) {
      this.handle.unmount()
      this.handle = null
    }
    this.mountedForCity = cityId
    this.contentCache.clear()
    this.handle = mountVellumFiberCardPreview(this.el, {
      cityId,
      originId: this.originIdFor?.(),
      width: this.width,
    })
  }

  private position(anchor: { x: number; y: number }): void {
    const width = this.el.offsetWidth || this.width
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
