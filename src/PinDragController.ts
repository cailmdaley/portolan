// PinDragController.ts - Long-press a fiber in the HUD, drag onto the map,
// release over a hex to pin the fiber at that world position. Milestone 2 of
// `tapestry-dissolves`: drag-to-pin replacing the dev helpers on `window`.
//
// Flow:
//   1. pointerdown on `.hud-fiber-item` → arm a timer (LONG_PRESS_MS).
//   2. If the pointer moves more than MOVE_CANCEL_PX before the timer fires,
//      cancel so the user can still scroll the fiber list.
//   3. Timer fires → enter drag mode: build a ghost element that follows the
//      cursor, add a `.pin-dragging` class on <body> to hide normal cursors.
//   4. On pointerup: if the release is over the canvas and camera.screenToWorld
//      returns a point, persist via putPin + upsert the renderer. Otherwise
//      cancel cleanly.
//   5. Escape cancels at any stage.
//
// Lives at the main-bootstrap layer because it needs the pin renderer, the
// camera (for screenToWorld), and the currently pinned city id — all of which
// are held in main.ts. Self-contained otherwise; depends only on the DOM.
import type { Pin } from './state/layoutClient'
import { putPin } from './state/layoutClient'

const LONG_PRESS_MS = 400
const MOVE_CANCEL_PX = 6

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
  private pressTimer: number | null = null
  private activeSlug: string | null = null
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
    this.startX = e.clientX
    this.startY = e.clientY
    this.phase = 'arming'
    this.pressTimer = window.setTimeout(() => this.startDrag(item), LONG_PRESS_MS)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.phase === 'arming') {
      const dx = e.clientX - this.startX
      const dy = e.clientY - this.startY
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) this.cancel()
      return
    }
    if (this.phase === 'dragging' && this.ghost) {
      this.ghost.style.left = `${e.clientX}px`
      this.ghost.style.top = `${e.clientY}px`
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.phase !== 'dragging') {
      this.cancel()
      return
    }
    const slug = this.activeSlug
    const cityId = this.opts.getPinnedCityId()
    this.cancel()
    if (!slug || !cityId) return
    if (!this.isOverCanvas(e)) return
    const world = this.opts.screenToWorld(e.clientX, e.clientY)
    if (!Number.isFinite(world.x) || !Number.isFinite(world.z)) return
    void putPin(cityId, slug, { x: world.x, z: world.z })
      .then(pin => this.opts.onPinned(pin))
      .catch(err => console.error('[pins] drag-to-pin failed', err))
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.phase !== 'idle') this.cancel()
  }

  private cancel = (): void => {
    if (this.pressTimer !== null) {
      clearTimeout(this.pressTimer)
      this.pressTimer = null
    }
    if (this.ghost) {
      this.ghost.remove()
      this.ghost = null
    }
    document.body.classList.remove('pin-dragging')
    this.phase = 'idle'
    this.activeSlug = null
  }

  private startDrag(item: HTMLElement): void {
    this.pressTimer = null
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
    // elementFromPoint respects stacking context — any HUD/modal above the
    // canvas wins, which is exactly what we want (don't pin through a modal).
    const el = document.elementFromPoint(e.clientX, e.clientY)
    return el === this.opts.canvas
  }
}

function escapeText(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
