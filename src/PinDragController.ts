// PinDragController.ts - Click a fiber in the HUD, drag onto the map, release
// over a hex to pin the fiber at that world position. Milestone 2 of
// `tapestry-dissolves`: drag-to-pin replacing the dev helpers on `window`.
//
// Flow:
//   1. pointerdown on `.hud-fiber-item` → arm. No timer.
//   2. First pointermove past DRAG_THRESHOLD_PX enters drag mode: build a
//      ghost that follows the cursor; add `.pin-dragging` on <body>.
//   3. On pointerup: if screenToWorld returns a finite point inside the canvas
//      bounding rect, persist via putPin + upsert the renderer.
//   4. Escape cancels at any stage.
//
// Why no long-press: user feedback 2026-04-14 — "super not intuitive it should
// just be click and drag, no long-press." HUD rows have their own click path
// (opening the fiber), but that fires on pointerup with no movement, so a
// pure move-threshold gesture coexists cleanly.
//
// Lives at the main-bootstrap layer because it needs the pin renderer, the
// camera (for screenToWorld), and the currently pinned city id — all of which
// are held in main.ts. Self-contained otherwise; depends only on the DOM.
import type { Pin } from './state/layoutClient'
import { putPin } from './state/layoutClient'

const DRAG_THRESHOLD_PX = 4

interface PinDragOptions {
  canvas: HTMLCanvasElement
  screenToWorld: (x: number, y: number) => { x: number; z: number }
  getPinnedCityId: () => string | null
  onPinned: (pin: Pin) => void
}

type Phase = 'idle' | 'arming' | 'dragging'

export class PinDragController {
  private readonly opts: PinDragOptions
  private phase: Phase = 'idle'
  private activeSlug: string | null = null
  private armedItem: HTMLElement | null = null
  private startX = 0
  private startY = 0
  private ghost: HTMLElement | null = null

  constructor(opts: PinDragOptions) {
    this.opts = opts
    document.addEventListener('pointerdown', this.onPointerDown, true)
    document.addEventListener('pointermove', this.onPointerMove, true)
    document.addEventListener('pointerup', this.onPointerUp, true)
    document.addEventListener('pointercancel', this.cancel, true)
    window.addEventListener('keydown', this.onKeyDown, true)
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('pointerup', this.onPointerUp, true)
    document.removeEventListener('pointercancel', this.cancel, true)
    window.removeEventListener('keydown', this.onKeyDown, true)
    this.cancel()
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    const item = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.hud-fiber-item')
    if (!item) return
    // The handoff button lives inside the item; don't hijack it.
    if ((e.target as HTMLElement).closest('.hud-fiber-handoff')) return
    const slug = item.dataset.fiberId
    if (!slug) return
    this.activeSlug = slug
    this.armedItem = item
    this.startX = e.clientX
    this.startY = e.clientY
    this.phase = 'arming'
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.phase === 'arming') {
      const dx = e.clientX - this.startX
      const dy = e.clientY - this.startY
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        if (this.armedItem) this.startDrag(this.armedItem)
      }
      return
    }
    if (this.phase === 'dragging' && this.ghost) {
      this.ghost.style.left = `${e.clientX}px`
      this.ghost.style.top = `${e.clientY}px`
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.phase !== 'dragging') {
      // Plain click (no drag) — let the HUD's own click handler run.
      this.cancel()
      return
    }
    // Suppress the synthetic click that follows pointerup so the HUD's fiber
    // click handler (opens the file) doesn't fire after a drag completes.
    const suppressClick = (ev: Event): void => {
      ev.stopPropagation()
      ev.preventDefault()
      window.removeEventListener('click', suppressClick, true)
    }
    window.addEventListener('click', suppressClick, true)
    window.setTimeout(() => window.removeEventListener('click', suppressClick, true), 0)
    const slug = this.activeSlug
    const cityId = this.opts.getPinnedCityId()
    this.cancel()
    if (!slug) {
      console.warn('[pins] drag-to-pin: no active slug')
      return
    }
    if (!cityId) {
      console.warn('[pins] drag-to-pin: no pinned city; open a city first')
      return
    }
    if (!this.isOverCanvas(e)) {
      console.warn('[pins] drag-to-pin: release not over canvas bounds')
      return
    }
    const world = this.opts.screenToWorld(e.clientX, e.clientY)
    if (!Number.isFinite(world.x) || !Number.isFinite(world.z)) {
      console.warn('[pins] drag-to-pin: screenToWorld returned non-finite', world)
      return
    }
    void putPin(cityId, slug, { x: world.x, z: world.z })
      .then(pin => this.opts.onPinned(pin))
      .catch(err => console.error('[pins] drag-to-pin failed', err))
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.phase !== 'idle') this.cancel()
  }

  private cancel = (): void => {
    if (this.ghost) {
      this.ghost.remove()
      this.ghost = null
    }
    document.body.classList.remove('pin-dragging')
    this.phase = 'idle'
    this.activeSlug = null
    this.armedItem = null
  }

  private startDrag(item: HTMLElement): void {
    if (this.phase !== 'arming' || !this.activeSlug) return
    this.phase = 'dragging'
    this.ghost = this.buildGhost(this.activeSlug, item)
    document.body.appendChild(this.ghost)
    this.ghost.style.left = `${this.startX}px`
    this.ghost.style.top = `${this.startY}px`
    document.body.classList.add('pin-dragging')
  }

  private buildGhost(slug: string, source: HTMLElement): HTMLElement {
    const el = document.createElement('div')
    el.className = 'pin-drag-ghost'
    const title = source.querySelector('.hud-fiber-title')?.textContent ?? slug
    el.innerHTML = `<span class="pin-drag-pin">📍</span><span class="pin-drag-label">${escapeText(title)}</span>`
    return el
  }

  private isOverCanvas(e: PointerEvent): boolean {
    // Geometry, not stacking. The canvas fills the window but the HUD sidebar,
    // top bar, menus, and the drag ghost itself all overlay it — strict
    // elementFromPoint equality silently rejected drops released on top of any
    // of those. If the pointer is inside the canvas's bounding rect, treat it
    // as a valid drop; upstream modals that want to block drops can stop the
    // event before we see it.
    const rect = this.opts.canvas.getBoundingClientRect()
    return (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    )
  }
}

function escapeText(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
