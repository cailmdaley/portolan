// DomPinLayer.ts — unified DOM overlay for every pinned card, fiber and file.
//
// Real DOM nodes anchored to world-space `{x, z}` and reprojected each frame
// via `Camera.worldToScreen`. Fiber pins mount vellum's FiberCard; text pins
// mount vellum's FileViewerPage (same surface as the modal); pdf/html render
// into an iframe; images into an <img>; other kinds fall back to a link card.
//
// Sits in a sibling overlay above the canvas. Wrapper is `pointer-events: none`
// so empty space falls through to the map; each pin element opts back in to
// `pointer-events: auto`. `PinRenderer` (three.js fiber cards) has been
// retired — all kinds route here. See `tapestry-dissolves`, `card-modal-parity`.
//
// Zoom model (see `pin-text-stays-screen-size`, `card-redesign`): pins have an
// intrinsic *world* size (persisted as `pin.width`/`height`, interpreted as
// CSS px at `REFERENCE_ZOOM`). Each frame the card's CSS width/height is
// projected to screen pixels as `worldSize × (REFERENCE_ZOOM / zoom)`; nothing
// inside is transform-scaled. Text renders at its authored CSS size at every
// zoom — readable whether the card is a postage stamp or fills the viewport.

import type { Camera } from './Camera'
import type { Pin, PinKind } from '../state/layoutClient'

const DOM_KINDS: ReadonlySet<PinKind> = new Set([
  'fiber', 'pdf', 'html', 'image', 'text', 'other',
])

export type FiberStatus = 'open' | 'active' | 'closed'

/** Status → glyph + color. Mirrors the felt CLI legend
 *  ("· untracked, ○ open, ◐ active, ● closed") and the palette canvas pins
 *  used before the DomPinLayer migration retired them. */
const STATUS_GLYPHS: Record<FiberStatus, { glyph: string; color: string; label: string }> = {
  open:   { glyph: '○', color: '#5A7B7B', label: 'open' },
  active: { glyph: '◐', color: '#9A7B35', label: 'active' },
  closed: { glyph: '●', color: '#2E2A26', label: 'closed' },
}

// Reference zoom (camera half-width in world units) at which a DOM pin renders
// at its intrinsic CSS size — i.e. scale = 1. Picked near the middle of the
// effective zoom range (Camera clamps to [2, 15]) so PDFs render at "natural"
// readable size at a typical city-level view, then shrink as you pull out and
// grow as you push in.
const REFERENCE_ZOOM = 8

/** Kind-specific default intrinsic CSS sizes — applied when a pin has no
 *  persisted width/height. Matches the pre-existing inline iframe/img defaults
 *  below, so pins that pre-date size-persistence render at identical size. */
interface KindSize { width: number; height: number }
const DEFAULT_SIZE: Record<PinKind, KindSize> = {
  fiber: { width: 320, height: 320 },
  text: { width: 420, height: 420 },
  pdf: { width: 320, height: 420 },
  html: { width: 420, height: 300 },
  image: { width: 320, height: 320 },
  other: { width: 260, height: 120 },
}
const MIN_SIZE = 120
const MAX_SIZE = 1600

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se']

/** True if a pin should render via the DOM layer. All kinds route to DOM. */
export function isDomPinKind(pin: Pin): boolean {
  return DOM_KINDS.has(pin.kind)
}

/**
 * Mount a vellum file surface (FileViewerPage) into a host container. Optional
 * — when provided, text pins render their content inline via vellum instead of
 * falling back to the link-card stub. Same `editable`/`jumpToLine` surface the
 * modal path uses, so the card is "the modal pinned to a map coordinate" —
 * same edit, save, annotations, jump-to-line. See [[card-modal-parity]] and
 * [[file-view-as-floating-card]].
 */
export interface VellumSurfaceMount {
  unmount(): void
  /** Reflow the mounted surface to a new CSS width. Called while the user
   *  resizes the pin so content (pretext line wrapping, prose column) tracks
   *  the card instead of stranding empty space. Only fiber mounts currently
   *  react; file surfaces ignore the hint (they already fill via CSS). */
  resize?(width: number): void
}

export type MountVellumFileSurface = (
  container: HTMLElement,
  opts: {
    path: string
    originId?: string
    cityId?: string
    editable?: boolean
    jumpToLine?: number
    /** Fires when the document's dirty bit flips. Text-pin chrome paints a
     *  dirty dot based on this so the user sees a card has unsaved edits
     *  without opening it. See constitution invariant 5. */
    onDirtyChange?: (dirty: boolean) => void
    /** Fires when save state transitions. Chrome shows a transient "Saving…"
     *  → "Saved" status next to the Save button. */
    onSaveStateChange?: (state: ChromeSaveState) => void
    /** Handed a save trigger once the mount is ready; `null` on unmount or
     *  when the file becomes non-editable. Text-pin chrome's Save button
     *  wires its click handler to this. */
    onSaveReady?: (save: (() => Promise<void>) | null) => void
  },
) => VellumSurfaceMount

/**
 * Inline vellum mount for fiber-kind DOM pins. Renders vellum's FiberCard
 * with fetched body; see `tapestry-dissolves` Next and [[file-view-as-floating-card]].
 */
export type MountVellumFiberSurface = (
  container: HTMLElement,
  opts: { slug: string; cityId?: string; originId?: string; hideTitle?: boolean; width?: number },
) => VellumSurfaceMount

export interface DomPinLayerOptions {
  camera: Camera
  /** Map a pin's `source` into a fetchable URL. Returns null when the source
   *  can't be resolved (unknown originId, missing fields, etc.) — the pin is
   *  rendered as a stub placeholder so the user still sees it on the map. */
  resolveSource: (pin: Pin) => string | null
  /** Right-click on a DOM pin → host opens a context menu (unpin, …). */
  onContextMenu?: (slug: string, clientX: number, clientY: number) => void
  /** Double-click on the chrome strip → host opens the pin's primary surface
   *  (fiber workspace, vellum file modal, external URL — whatever "Open" means
   *  for this kind). Discoverability shortcut so the Open action doesn't live
   *  behind right-click only. */
  onPrimaryOpen?: (slug: string) => void
  /** Inline vellum mount for markdown file pins. */
  mountVellumSurface?: MountVellumFileSurface
  /** Inline vellum mount for fiber pins (renders vellum's FiberCard). */
  mountVellumFiberSurface?: MountVellumFiberSurface
  /** Default cityId threaded into vellum mounts when a pin lacks an originId hint. */
  cityIdFor?: () => string | undefined
  /** Convert screen pixels to world coords. Required for chrome-strip drag. */
  screenToWorld?: (x: number, y: number) => { x: number; z: number }
  /** Persist a pin's new world position after a chrome-strip drag completes. */
  onPinMoved?: (slug: string, x: number, z: number) => void
  /** Persist a pin's new intrinsic CSS size after a resize-handle drag completes.
   *  See [[file-view-as-floating-card]]. */
  onPinResized?: (slug: string, width: number, height: number) => void
  /** Resolve a pin's display title and (for fiber pins) status asynchronously.
   *  Title fills the chrome strip in place of the raw slug; status paints a
   *  glyph on the chrome's left side so the user sees a fiber's open/active/
   *  closed state without opening the card. Either field returning null falls
   *  back to its default (sync `titleForPin`; no glyph). */
  resolveFiberMeta?: (pin: Pin) => Promise<{ name?: string | null; status?: FiberStatus | null } | null>
  /** Map→HUD hover bridge: fires when the cursor enters or leaves a pin element.
   *  DOM pins sit above the canvas and swallow pointer events, so the canvas
   *  hit-test in MapInteractionController never sees hovers over a pin. This
   *  callback closes that loop so the HUD can light up the matching row. */
  onHover?: (slug: string | null) => void
}

interface DomPinEntry {
  slug: string
  pin: Pin
  el: HTMLDivElement
  inner: HTMLElement
  chrome: HTMLElement
  vellumMount: VellumSurfaceMount | null
  /** Intrinsic world size — persisted as `pin.width`/`height`. Interpreted as
   *  CSS pixels at `REFERENCE_ZOOM`; the per-frame CSS size is this × the
   *  current zoom ratio. See constitution invariant 1. */
  width: number
  height: number
  /** Last CSS width passed to `vellumMount.resize()`. Used to gate reflow
   *  calls so React doesn't re-render every frame during a pan. */
  lastReflowWidth: number
}

export class DomPinLayer {
  private readonly camera: Camera
  private readonly resolveSource: (pin: Pin) => string | null
  private readonly onContextMenu?: (slug: string, clientX: number, clientY: number) => void
  private readonly onPrimaryOpen?: (slug: string) => void
  private readonly mountVellumSurface?: MountVellumFileSurface
  private readonly mountVellumFiberSurface?: MountVellumFiberSurface
  private readonly cityIdFor?: () => string | undefined
  private readonly screenToWorld?: (x: number, y: number) => { x: number; z: number }
  private readonly onPinMoved?: (slug: string, x: number, z: number) => void
  private readonly onPinResized?: (slug: string, width: number, height: number) => void
  private readonly resolveFiberMeta?: (pin: Pin) => Promise<{ name?: string | null; status?: FiberStatus | null } | null>
  private readonly onHover?: (slug: string | null) => void
  private readonly container: HTMLDivElement
  private readonly entries = new Map<string, DomPinEntry>()
  private hoveredSlug: string | null = null
  private zCounter = 0

  constructor(opts: DomPinLayerOptions) {
    this.camera = opts.camera
    this.resolveSource = opts.resolveSource
    this.onContextMenu = opts.onContextMenu
    this.onPrimaryOpen = opts.onPrimaryOpen
    this.mountVellumSurface = opts.mountVellumSurface
    this.mountVellumFiberSurface = opts.mountVellumFiberSurface
    this.cityIdFor = opts.cityIdFor
    this.screenToWorld = opts.screenToWorld
    this.onPinMoved = opts.onPinMoved
    this.onPinResized = opts.onPinResized
    this.resolveFiberMeta = opts.resolveFiberMeta
    this.onHover = opts.onHover

    this.container = document.createElement('div')
    this.container.className = 'dom-pin-layer'
    Object.assign(this.container.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '20',
    })
    document.body.appendChild(this.container)
    ensurePulseStyles()
  }

  /** Raise a pin above its siblings so stacked pins can be surfaced. Uses a
   *  monotonic counter on z-index so last-touched wins. Called on pointerdown
   *  anywhere on a pin element. */
  private raise(entry: DomPinEntry): void {
    this.zCounter += 1
    entry.el.style.zIndex = String(this.zCounter)
  }

  /** Brief visual pulse on an existing DOM pin — "yes, that's the one."
   *  Uses `filter: drop-shadow` via a CSS class so we don't fight the
   *  transform-based positioning that runs every frame. */
  pulse(slug: string): void {
    const entry = this.entries.get(slug)
    if (!entry) return
    entry.el.classList.remove('dom-pin--pulsing')
    // Force reflow so re-adding the class restarts the animation.
    void entry.el.offsetWidth
    entry.el.classList.add('dom-pin--pulsing')
    window.setTimeout(() => {
      entry.el.classList.remove('dom-pin--pulsing')
    }, 650)
  }

  setPins(pins: Pin[]): void {
    const next = new Set<string>()
    for (const pin of pins) {
      if (!isDomPinKind(pin)) continue
      next.add(pin.slug)
      this.upsert(pin)
    }
    for (const slug of [...this.entries.keys()]) {
      if (!next.has(slug)) this.remove(slug)
    }
  }

  upsert(pin: Pin): void {
    if (!isDomPinKind(pin)) {
      // Caller routed wrong; clean up if we used to own it.
      this.remove(pin.slug)
      return
    }
    const existing = this.entries.get(pin.slug)
    if (existing) {
      const sameKind = existing.pin.kind === pin.kind
      const sameSource = sourceKey(existing.pin) === sourceKey(pin)
      if (!sameKind || !sameSource) {
        this.remove(pin.slug)
      } else {
        existing.pin = pin
        // Size may have changed server-side (e.g. after a resize commit from
        // another surface); reflect it live before repositioning.
        const nextSize = resolveSize(pin)
        if (existing.width !== nextSize.width || existing.height !== nextSize.height) {
          existing.width = nextSize.width
          existing.height = nextSize.height
        }
        this.position(existing)
        return
      }
    }
    const entry = this.build(pin)
    this.container.appendChild(entry.el)
    this.entries.set(pin.slug, entry)
    this.position(entry)
  }

  remove(slug: string): void {
    const entry = this.entries.get(slug)
    if (!entry) return
    entry.vellumMount?.unmount()
    entry.el.remove()
    this.entries.delete(slug)
    if (this.hoveredSlug === slug) this.hoveredSlug = null
  }

  clear(): void {
    for (const slug of [...this.entries.keys()]) this.remove(slug)
  }

  has(slug: string): boolean {
    return this.entries.has(slug)
  }

  getSlugs(): string[] {
    return [...this.entries.keys()]
  }

  /** Read back a pin's current live state (includes live-mutated position from
   *  chrome-strip drags). Null when this layer doesn't own the slug. */
  getPin(slug: string): Pin | null {
    return this.entries.get(slug)?.pin ?? null
  }

  /** Per-frame: re-project every pin's world position to screen pixels. */
  reanchorAll(): void {
    for (const entry of this.entries.values()) this.position(entry)
  }

  setHovered(slug: string | null): void {
    if (this.hoveredSlug === slug) return
    if (this.hoveredSlug) {
      const prev = this.entries.get(this.hoveredSlug)
      prev?.el.classList.remove('dom-pin--hovered')
    }
    this.hoveredSlug = slug
    if (slug) {
      this.entries.get(slug)?.el.classList.add('dom-pin--hovered')
    }
  }

  private position(entry: DomPinEntry): void {
    const { x, y } = this.camera.worldToScreen(entry.pin.x, 0.05, entry.pin.z)
    // Zoom-scale decoupling: card CSS size = world size × (REFERENCE_ZOOM /
    // zoom). No transform: scale — text and chrome render at authored CSS px
    // at every zoom, so words stay pinned to the viewer's eye while the card
    // itself grows/shrinks as the camera moves. See constitution invariant 1.
    const ratio = this.zoomRatio()
    const cssW = Math.max(8, entry.width * ratio)
    const cssH = Math.max(8, entry.height * ratio)
    entry.el.style.width = `${cssW}px`
    entry.el.style.height = `${cssH}px`
    entry.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
    // Notify fiber mounts when the projected width crossed a meaningful
    // threshold so FiberCard's pretext reflows with the card, without
    // thrashing React every frame during a pan.
    if (entry.vellumMount?.resize && Math.abs(cssW - entry.lastReflowWidth) >= 8) {
      entry.lastReflowWidth = cssW
      entry.vellumMount.resize(cssW)
    }
  }

  private zoomRatio(): number {
    return REFERENCE_ZOOM / Math.max(this.camera.cameraDistance, 0.0001)
  }

  private build(pin: Pin): DomPinEntry {
    const url = this.resolveSource(pin)
    const el = document.createElement('div')
    el.className = `dom-pin dom-pin--${pin.kind ?? 'other'}`
    el.dataset.slug = pin.slug
    Object.assign(el.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      pointerEvents: 'auto',
      display: 'flex',
      flexDirection: 'column',
      // Intrinsic size lives on the wrapper; inner bodies fill it via flex:1.
      // Camera-zoom scale is applied by `position()` and multiplies these.
      // No `transition` on transform: `reanchorAll()` pushes a fresh transform
      // every frame (60fps), so any transition just makes the pin lag behind
      // the camera during zoom/pan. Discrete state changes (hover, pulse) use
      // other properties (filter, opacity).
      boxSizing: 'border-box',
    })
    const size = resolveSize(pin)

    // Chrome strip — a pointer-event handle that stays *outside* the iframe's
    // own event scope. Right-click or clicking the ⋮ opens the host context
    // menu; dragging/scrolling the iframe below never reaches the wrapper, so
    // this strip is the only reliable unpin affordance for iframe-backed pins
    // (PDF/HTML). See tapestry-dissolves: "right-click unpin from a PDF that
    // swallows pointer events."
    const chrome = renderChrome(pin, titleForPin(pin))
    el.appendChild(chrome)
    if (this.resolveFiberMeta) {
      void this.resolveFiberMeta(pin).then((meta) => {
        if (!meta) return
        // Entry may have been removed by the time the promise resolves.
        if (this.entries.get(pin.slug)?.el !== el) return
        if (meta.name) setChromeTitle(chrome, meta.name, pin)
        if (meta.status) setChromeStatus(chrome, meta.status)
      }).catch(() => {})
    }

    let vellumMount: VellumSurfaceMount | null = null
    let inner: HTMLElement
    if (pin.kind === 'fiber' && this.mountVellumFiberSurface) {
      inner = renderVellumShell()
      vellumMount = this.mountVellumFiberSurface(inner, {
        slug: pin.slug,
        cityId: this.cityIdFor?.(),
        width: size.width,
        // Chrome strip above the card already carries the fiber name +
        // status glyph; suppress FiberCard's own title to avoid duplication.
        // See fiber-pin-title-duplication.
        hideTitle: true,
      })
    } else if (pin.kind === 'text' && pin.source?.path && this.mountVellumSurface) {
      inner = renderVellumShell()
      // Card ↔ modal parity: the card mounts the same vellum FileViewerPage as
      // the modal and must expose the same edit/save surface. `openFile()` in
      // main.ts defaults modals to `editable: true`; mirror that here so cards
      // aren't a read-only second-class citizen. See [[card-modal-parity]].
      vellumMount = this.mountVellumSurface(inner, {
        path: pin.source.path,
        originId: pin.source.originId,
        cityId: this.cityIdFor?.(),
        editable: true,
        // Lift save state from vellum's FileViewerPage into the pin's chrome
        // strip — dirty dot, transient status text, Save button. The vellum
        // page itself is mounted with `hideToolbar` so we don't stack two
        // bars. See constitution invariant 5 and
        // mountVellumFileSurface.hideToolbar in mount.tsx.
        onDirtyChange: (d) => setChromeDirty(chrome, d),
        onSaveStateChange: (s) => setChromeSaveState(chrome, s),
        onSaveReady: (save) => setChromeSaveAction(chrome, save),
      })
    } else {
      inner = renderInner(pin, url)
    }
    el.appendChild(inner)

    if (this.onContextMenu) {
      const openMenu = (clientX: number, clientY: number) => {
        this.onContextMenu?.(pin.slug, clientX, clientY)
      }
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY)
      })
      const handle = chrome.querySelector<HTMLElement>('.dom-pin-menu-handle')
      handle?.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY)
      })
    }
    const entry: DomPinEntry = {
      slug: pin.slug,
      pin,
      el,
      inner,
      chrome,
      vellumMount,
      width: size.width,
      height: size.height,
      lastReflowWidth: 0,
    }
    // Bring-to-front on any interaction — stacked pins (e.g. a large markdown
    // card over a fiber pin) need a way to surface. Capture phase so we raise
    // before downstream drag/resize/chrome handlers consume the event.
    el.addEventListener('pointerdown', () => this.raise(entry), true)
    this.raise(entry)
    // Map→HUD hover bridge. pointerenter fires once per pin when the pointer
    // crosses into its bounds; DOM stacking means only the topmost pin gets
    // the event even when cards overlap. Suppressed during drag/move flows
    // for the same reason the HUD suppresses its highlight then.
    if (this.onHover) {
      el.addEventListener('pointerenter', () => {
        if (document.body.classList.contains('pin-dragging')) return
        this.onHover!(pin.slug)
      })
      el.addEventListener('pointerleave', () => {
        this.onHover!(null)
      })
    }
    this.attachChromeDrag(chrome, entry)
    // One wheel handler for the whole card. Plain wheel bubbles into the
    // native overflow-scroll of whatever child owns it (vellum-shell,
    // iframes); `stopPropagation` keeps the camera from zooming in parallel.
    // Cmd/Ctrl + wheel resizes the card's intrinsic world size anywhere on
    // the card — body included, not just the chrome strip. See constitution
    // invariant 3 and `pin-resize-gesture-moves-target`.
    this.attachWheelResize(el, entry)
    if (this.onPrimaryOpen) {
      // Double-click on chrome → host's "Open" action (fiber workspace, vellum
      // modal, external URL). Chrome-only so iframe/body scroll-regions never
      // eat the gesture, and so double-clicking text inside a fiber card
      // doesn't accidentally open the workspace.
      chrome.addEventListener('dblclick', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.onPrimaryOpen!(entry.slug)
      })
    }
    // Four resize handles, one per corner — dragging any of them resizes the
    // card while the opposite corner stays pinned in world space. Handles sit
    // above iframe event scope so pdf/html pins still catch the gesture. See
    // constitution invariant 4.
    for (const corner of CORNERS) {
      const handle = renderResizeHandle(corner)
      el.appendChild(handle)
      this.attachResize(handle, entry, corner)
    }
    return entry
  }

  /** Wheel gesture on the card. Always stops propagation so the camera doesn't
   *  zoom in parallel with whatever the user is doing to the card.
   *
   *  - Cmd/Ctrl + wheel: resize the card's intrinsic world size, anywhere on
   *    the card (chrome, body, corners). Factor is proportional to `deltaY`
   *    so trackpad gestures feel continuous and mouse-wheel notches land the
   *    same ~10% step the previous chrome-only version did. Commit is
   *    debounced so one gesture fires one persisted write. See
   *    [[pin-resize-gesture-moves-target]] and constitution invariant 3.
   *  - Plain wheel: forwarded to the browser so overflow containers inside
   *    the card (vellum-shell, iframes) scroll natively. */
  private attachWheelResize(el: HTMLElement, entry: DomPinEntry): void {
    const RATE = 0.001
    let commitTimer: number | null = null
    el.addEventListener('wheel', (event) => {
      event.stopPropagation()
      if (!(event.ctrlKey || event.metaKey)) return
      if (!this.onPinResized) return
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * RATE)
      entry.width = clampSize(entry.width * factor)
      entry.height = clampSize(entry.height * factor)
      this.position(entry)
      if (commitTimer !== null) window.clearTimeout(commitTimer)
      commitTimer = window.setTimeout(() => {
        commitTimer = null
        this.onPinResized!(entry.slug, entry.width, entry.height)
      }, 220)
    }, { passive: false })
  }

  /** Wire a pointerdown on the chrome strip into a drag gesture that updates
   *  the pin's world position live and persists on release. Skipped if the host
   *  didn't provide `screenToWorld` / `onPinMoved`. Primary pointer only;
   *  right-click and the menu-handle button are excluded so the context-menu
   *  path still works. */
  private attachChromeDrag(chrome: HTMLElement, entry: DomPinEntry): void {
    if (!this.screenToWorld || !this.onPinMoved) return

    const DRAG_THRESHOLD_PX = 3
    chrome.style.cursor = 'grab'

    chrome.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const target = event.target as Element | null
      if (target?.closest('.dom-pin-menu-handle')) return

      const startX = event.clientX
      const startY = event.clientY
      // Capture the offset from cursor world to pin anchor at drag start so the
      // card doesn't snap-recentre under the cursor. Without this, grabbing the
      // chrome strip (top of card) re-anchors the card center to the cursor on
      // the first move, jerking the card downward before it starts tracking.
      const startWorld = this.screenToWorld!(startX, startY)
      const offsetX = entry.pin.x - startWorld.x
      const offsetZ = entry.pin.z - startWorld.z
      let active = false

      const onMove = (ev: PointerEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return
          active = true
          entry.el.classList.add('dom-pin--dragging')
          chrome.style.cursor = 'grabbing'
          document.body.style.cursor = 'grabbing'
          // Reuse the drag-to-pin suppression flag so MapInteractionController's
          // canvas-hover early-returns apply to chrome-strip drags too.
          document.body.classList.add('pin-dragging')
        }
        const world = this.screenToWorld!(ev.clientX, ev.clientY)
        entry.pin = { ...entry.pin, x: world.x + offsetX, z: world.z + offsetZ }
        this.position(entry)
      }

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        if (!active) return
        entry.el.classList.remove('dom-pin--dragging')
        chrome.style.cursor = 'grab'
        document.body.style.cursor = ''
        document.body.classList.remove('pin-dragging')
        // Commit final world position. Read from the last pointer event
        // because `entry.pin` was updated per-move above.
        const world = this.screenToWorld!(ev.clientX, ev.clientY)
        this.onPinMoved!(entry.slug, world.x + offsetX, world.z + offsetZ)
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)

      event.preventDefault()
      event.stopPropagation()
    })
  }

  /** Pointerdown on a corner handle → drag to resize. The opposite corner
   *  stays pinned in world space — dragging SE grows toward the SE while NW
   *  stays put; dragging NW grows toward NW while SE stays put; etc. Because
   *  the pin's anchor is the card's *center*, the anchor shifts by half the
   *  size delta (signed by corner direction) each frame, and we commit the
   *  new position on release.
   *
   *  Screen-pixel deltas are divided by the current zoom ratio so one screen
   *  pixel of drag equals one *world* pixel of size change — the card feels
   *  equally responsive at every zoom. Hold Shift (or resize images —
   *  intrinsic aspect) to preserve the starting aspect ratio; the dominant-
   *  axis delta drives the minor axis so the handle tracks the cursor.
   *
   *  See constitution invariant 4. Commits via `onPinResized` and
   *  `onPinMoved`; skipped if the host didn't provide `onPinResized`. */
  private attachResize(handle: HTMLElement, entry: DomPinEntry, corner: Corner): void {
    if (!this.onPinResized) return
    // Sign of the width/height delta for this corner: +1 means "growing this
    // side extends along +x / +y (cursor going SE)"; -1 means the opposite.
    const sx = corner === 'ne' || corner === 'se' ? 1 : -1
    const sy = corner === 'sw' || corner === 'se' ? 1 : -1

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startY = event.clientY
      const startW = entry.width
      const startH = entry.height
      const startPinX = entry.pin.x
      const startPinZ = entry.pin.z
      const aspect = startW / Math.max(startH, 1)
      const ratio = this.zoomRatio()
      let active = false

      const onMove = (ev: PointerEvent) => {
        const dxScreen = ev.clientX - startX
        const dyScreen = ev.clientY - startY
        if (!active) {
          if (Math.hypot(dxScreen, dyScreen) < 2) return
          active = true
          entry.el.classList.add('dom-pin--resizing')
          document.body.style.cursor = cornerCursor(corner)
          // Reuse the same suppression flag as drag-to-pin / chrome-drag so
          // pin-hover and canvas interactions don't interfere mid-resize.
          document.body.classList.add('pin-dragging')
        }
        // Screen-pixel drag → world-pixel size delta. sx/sy map the cursor's
        // motion into growth along the corner's direction.
        let nextW = startW + (sx * dxScreen) / ratio
        let nextH = startH + (sy * dyScreen) / ratio
        const lockAspect = ev.shiftKey || entry.pin.kind === 'image'
        if (lockAspect) {
          if (Math.abs(dxScreen) >= Math.abs(dyScreen)) {
            nextH = nextW / aspect
          } else {
            nextW = nextH * aspect
          }
        }
        nextW = clampSize(nextW)
        nextH = clampSize(nextH)
        // Opposite-corner-fixed anchor math. Pin anchor is the card center
        // (via `translate(-50%, -50%)`), so keeping corner `-sx, -sy` fixed
        // means shifting the center by (dW/2 along sx, dH/2 along sy) in
        // world units. Using `sx * (ratio_unit_world)`: world coords are the
        // same units as `entry.width` (world px at REFERENCE_ZOOM), so the
        // center shift is simply half the world-size delta in that direction.
        const dW = nextW - startW
        const dH = nextH - startH
        entry.width = nextW
        entry.height = nextH
        // The map's +x is screen-right and +z is screen-down (see Camera
        // projection). So sx maps to world x and sy maps to world z.
        entry.pin = {
          ...entry.pin,
          x: startPinX + (sx * dW) / 2,
          z: startPinZ + (sy * dH) / 2,
        }
        this.position(entry)
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        if (!active) return
        entry.el.classList.remove('dom-pin--resizing')
        document.body.style.cursor = ''
        document.body.classList.remove('pin-dragging')
        this.onPinResized!(entry.slug, entry.width, entry.height)
        if (this.onPinMoved && (entry.pin.x !== startPinX || entry.pin.z !== startPinZ)) {
          this.onPinMoved(entry.slug, entry.pin.x, entry.pin.z)
        }
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)

      event.preventDefault()
      event.stopPropagation()
    })
  }
}

function cornerCursor(corner: Corner): string {
  return corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize'
}

let pulseStylesInjected = false
function ensurePulseStyles(): void {
  if (pulseStylesInjected) return
  pulseStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes dom-pin-pulse {
      0% { filter: drop-shadow(0 0 0 rgba(154, 123, 53, 0)); }
      30% { filter: drop-shadow(0 0 18px rgba(154, 123, 53, 0.85)); }
      100% { filter: drop-shadow(0 0 0 rgba(154, 123, 53, 0)); }
    }
    .dom-pin--pulsing {
      animation: dom-pin-pulse 600ms ease-out;
    }
    /* Resize handles: four corner dots. Invisible by default so a quiet map
       stays quiet; on card hover they fade in as faint parchment marks,
       becoming solid on handle-hover. Constitution's "quiet by default +
       hover reveals affordances." 6px dot centered in an 18px hit area. */
    .dom-pin .dom-pin-resize {
      opacity: 0;
      transition: opacity 120ms ease-out;
    }
    .dom-pin .dom-pin-resize::after {
      content: '';
      position: absolute;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: rgba(140, 110, 80, 0.7);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }
    .dom-pin:hover .dom-pin-resize,
    .dom-pin--hovered .dom-pin-resize,
    .dom-pin--resizing .dom-pin-resize {
      opacity: 0.7;
    }
    .dom-pin .dom-pin-resize:hover,
    .dom-pin--resizing .dom-pin-resize {
      opacity: 1;
    }
    /* Chrome strip hover: darken slightly so the grab surface advertises itself
       when the cursor enters it. Transition short so it doesn't feel sluggish. */
    .dom-pin-chrome {
      transition: background-color 120ms ease-out;
      container-type: inline-size;
    }
    .dom-pin-chrome:hover {
      background: rgba(184, 168, 150, 0.96) !important;
    }
    /* Chrome degradation: as the card narrows, non-essential chrome fades in
       priority order so the filename survives as the last-to-go. Constitution
       invariant 5: "Chrome holds the filename at all widths; other chrome
       elements stay visible as long as they fit." Priority: Save button first,
       then save-status text, then the dirty dot, then the ⋮ handle — filename
       and status glyph are last. Thresholds picked to leave the title roughly
       one filename-word wide at each cutoff; tune by eye on real cards. */
    @container (max-width: 200px) {
      .dom-pin-chrome-save { display: none !important; }
    }
    @container (max-width: 160px) {
      .dom-pin-chrome-save-status { display: none !important; }
    }
    @container (max-width: 130px) {
      .dom-pin-chrome-dirty { display: none !important; }
    }
    @container (max-width: 100px) {
      .dom-pin-menu-handle { display: none !important; }
    }
    /* Menu handle (⋮): soft round background on hover/focus so it reads as a
       real button rather than inert text. */
    .dom-pin-menu-handle {
      border-radius: 4px;
      transition: background-color 120ms ease-out;
    }
    .dom-pin-menu-handle:hover,
    .dom-pin-menu-handle:focus-visible {
      background: rgba(46, 42, 38, 0.12) !important;
      outline: none;
    }
    /* External-open affordance on URL pins: faint until the chrome is hovered
       so it doesn't clutter a quiet map, obvious the moment the user reaches
       for it. Matches the resize-handle reveal pattern. */
    .dom-pin-chrome-ext {
      opacity: 0.55;
      transition: opacity 120ms ease-out, background-color 120ms ease-out;
    }
    .dom-pin-chrome:hover .dom-pin-chrome-ext,
    .dom-pin-chrome-ext:focus-visible {
      opacity: 1;
      outline: none;
    }
    .dom-pin-chrome-ext:hover {
      background: rgba(46, 42, 38, 0.12) !important;
    }
    /* Hover state from the HUD bridge (setHovered) adds the class; browser
       :hover handles the on-map case. Both raise the pin slightly and deepen
       the shadow so the user sees "yes, that one." Filter transitions without
       touching transform, which is rewritten every frame by reanchorAll(). */
    .dom-pin {
      transition: filter 140ms ease-out;
    }
    .dom-pin:hover,
    .dom-pin--hovered {
      filter: drop-shadow(0 6px 12px rgba(46, 42, 38, 0.28));
    }
    /* Heading tame-down inside pin bodies: MyST renders h1 at ~2x body, which
       dominates a small card. Scale headings toward body size so the lede
       reads first, not the title. Anchors (the MyST ¶/# cross-reference
       hover links) aren't useful in a spatial reader — always hide them. */
    .dom-pin-vellum-shell h1 { font-size: 1.25em; line-height: 1.25; margin: 0.25em 0 0.35em; }
    .dom-pin-vellum-shell h2 { font-size: 1.15em; line-height: 1.25; margin: 0.5em 0 0.3em; }
    .dom-pin-vellum-shell h3 { font-size: 1.05em; line-height: 1.3; margin: 0.5em 0 0.25em; }
    .dom-pin-vellum-shell h4, .dom-pin-vellum-shell h5, .dom-pin-vellum-shell h6 {
      font-size: 1em; margin: 0.4em 0 0.2em;
    }
    .dom-pin-vellum-shell a.anchor,
    .dom-pin-vellum-shell h1 > a[href^="#"],
    .dom-pin-vellum-shell h2 > a[href^="#"],
    .dom-pin-vellum-shell h3 > a[href^="#"],
    .dom-pin-vellum-shell h4 > a[href^="#"],
    .dom-pin-vellum-shell h5 > a[href^="#"],
    .dom-pin-vellum-shell h6 > a[href^="#"] {
      display: none !important;
    }
    /* FiberCard paints its own near-white background for vellum's reader
       context, but inside a pin shell that clashes with the parchment chrome
       and the warmer map tone. Let the shell's parchment show through so the
       pin reads as one warm card, not a white rectangle bolted into leather. */
    .dom-pin-vellum-shell .fiber-card { background: transparent; }
  `
  document.head.appendChild(style)
}

function renderVellumShell(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'dom-pin-vellum-shell'
  Object.assign(div.style, {
    flex: '1 1 auto',
    minHeight: '0',
    overflow: 'auto',
    overscrollBehavior: 'contain',
    border: '1px solid rgba(140, 110, 80, 0.55)',
    borderTop: 'none',
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
    background: 'rgba(248, 240, 225, 0.97)',
    boxShadow: '0 4px 16px rgba(46, 42, 38, 0.18)',
    color: '#2E2A26',
    fontFamily: '"EB Garamond", Garamond, serif',
  })
  return div
}

/** Decode percent-encoded URL segments for display, but fall back to the raw
 *  string if decoding fails (malformed %-sequence). Keeps chrome titles human
 *  readable instead of showing e.g. `Cantino_planisphere_%281502%29.jpg`. */
function decodeSafely(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** Sync fallback title for the chrome strip. For file handles we show the
 *  basename, for URLs the hostname, and for unresolved/empty sources the raw
 *  slug. Fiber pins use this as a placeholder until the async `resolveFiberMeta`
 *  hook returns the fiber's frontmatter `name`. */
function titleForPin(pin: Pin): string {
  const s = pin.source
  if (!s) return pin.slug
  if (s.path) {
    const base = s.path.split('/').filter(Boolean).pop()
    if (base) return decodeSafely(base)
  }
  if (s.url) {
    try {
      const u = new URL(s.url)
      const path = u.pathname.replace(/\/$/, '')
      const base = path ? decodeSafely(path.split('/').filter(Boolean).pop() ?? '') : ''
      return base ? `${u.hostname} / ${base}` : u.hostname
    } catch {
      return s.url
    }
  }
  return pin.slug
}

/** Authoritative long-form identifier for the chrome title tooltip. Fiber pins
 *  anchor on the slug (a meaningful short name). File and URL pins anchor on
 *  the full path/URL — their slugs are sha16 hashes that carry no information
 *  for the user. Shown as `displayTitle · anchor` when they differ, or just
 *  the anchor when the chrome already shows it. */
function chromeTooltip(pin: Pin, displayTitle: string): string {
  const anchor = pin.source?.path
    ? decodeSafely(pin.source.path)
    : pin.source?.url
      ? decodeSafely(pin.source.url)
      : pin.slug
  return displayTitle === anchor ? anchor : `${displayTitle} · ${anchor}`
}

function renderChrome(pin: Pin, displayTitle: string): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'dom-pin-chrome'
  bar.title = 'Drag to move · double-click to open · right-click for menu'
  Object.assign(bar.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 6px 3px 8px',
    fontFamily: '"EB Garamond", Garamond, serif',
    fontSize: '11px',
    lineHeight: '1.1',
    color: '#2E2A26',
    background: 'rgba(200, 184, 168, 0.92)',
    borderTopLeftRadius: '6px',
    borderTopRightRadius: '6px',
    borderBottom: '1px solid rgba(140, 110, 80, 0.45)',
    userSelect: 'none',
  })
  // Status glyph: empty until `resolveFiberMeta` paints one (fiber pins only).
  // Width reserved so the title doesn't shift when the glyph appears. The slot
  // is decorative — hide it from assistive tech so screen readers don't
  // announce the placeholder dot on every non-fiber pin.
  const status = document.createElement('span')
  status.className = 'dom-pin-chrome-status'
  status.setAttribute('aria-hidden', 'true')
  Object.assign(status.style, {
    display: 'inline-block',
    width: '12px',
    fontSize: '13px',
    lineHeight: '1',
    textAlign: 'center',
    color: 'transparent',
  })
  status.textContent = '·'
  bar.appendChild(status)
  const title = document.createElement('span')
  title.className = 'dom-pin-chrome-title'
  title.textContent = displayTitle
  title.title = chromeTooltip(pin, displayTitle)
  Object.assign(title.style, {
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  })
  applyChromeTitleCasing(title, displayTitle, pin.slug)
  bar.appendChild(title)
  // Save state strip for text pins — dirty dot, transient save-status text,
  // Save button. Hidden by default (empty content + `display: none` via the
  // body-free class); text pins populate them via `setChromeDirty` /
  // `setChromeSaveState` / `setChromeSaveAction` once vellum's callbacks fire.
  // Fiber / pdf / image / URL pins never call those helpers so the elements
  // stay collapsed. Order from left to right matches the constitution: dirty
  // dot nearest the title, status text, Save button, ⋮ menu handle. See
  // constitution invariant 5.
  const dirty = document.createElement('span')
  dirty.className = 'dom-pin-chrome-dirty'
  dirty.setAttribute('aria-hidden', 'true')
  dirty.textContent = '●'
  Object.assign(dirty.style, {
    display: 'none',
    fontSize: '9px',
    lineHeight: '1',
    color: '#9A7B35',
  })
  bar.appendChild(dirty)
  const saveStatus = document.createElement('span')
  saveStatus.className = 'dom-pin-chrome-save-status'
  saveStatus.setAttribute('aria-live', 'polite')
  Object.assign(saveStatus.style, {
    display: 'none',
    fontSize: '11px',
    color: '#7A7368',
    fontStyle: 'italic',
    whiteSpace: 'nowrap',
  })
  bar.appendChild(saveStatus)
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'dom-pin-chrome-save'
  saveBtn.textContent = 'Save'
  saveBtn.title = 'Save'
  saveBtn.tabIndex = -1
  Object.assign(saveBtn.style, {
    display: 'none',
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: '#2E2A26',
    fontFamily: '"EB Garamond", Garamond, serif',
    fontSize: '11px',
    letterSpacing: '0.03em',
    cursor: 'pointer',
    padding: '0 4px',
    borderRadius: '3px',
  })
  // Chrome-drag wants to ignore clicks on the button; the drag handler already
  // excludes the menu handle, and `stopPropagation` on pointerdown here keeps
  // a double-click on the button from being mistaken for a chrome grab.
  saveBtn.addEventListener('pointerdown', (e) => { e.stopPropagation() })
  bar.appendChild(saveBtn)
  // External-open affordance for URL pins. Iframe-blocked sites (X-Frame-Options
  // / CSP) render as a blank body and there's no reliable way to detect the
  // block from a cross-origin parent, so the pin can look broken at a glance.
  // A persistent ↗ button next to the ⋮ handle gives users an always-visible
  // escape hatch without waiting for dblclick-chrome or the right-click menu.
  // See iframe-blocked-not-detectable.
  if (pin.source?.url) {
    const ext = document.createElement('a')
    ext.className = 'dom-pin-chrome-ext'
    ext.href = pin.source.url
    ext.target = '_blank'
    ext.rel = 'noopener noreferrer'
    ext.textContent = '↗'
    ext.title = 'Open in browser'
    ext.setAttribute('aria-label', 'Open in browser')
    ext.tabIndex = -1
    Object.assign(ext.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '18px',
      height: '18px',
      borderRadius: '4px',
      color: '#2E2A26',
      fontSize: '13px',
      lineHeight: '1',
      textDecoration: 'none',
      cursor: 'pointer',
    })
    // Swallow pointerdown/click so the chrome-drag handler doesn't treat this
    // as a grab; the anchor's default click still opens the URL.
    ext.addEventListener('pointerdown', (e) => { e.stopPropagation() })
    ext.addEventListener('click', (e) => { e.stopPropagation() })
    bar.appendChild(ext)
  }
  const handle = document.createElement('button')
  handle.type = 'button'
  handle.className = 'dom-pin-menu-handle'
  handle.textContent = '⋮'
  handle.title = 'Pin menu'
  handle.setAttribute('aria-label', 'Pin menu')
  // Keep the button off the tab sequence — with many pins on the map, tabbing
  // through every ⋮ button ahead of actual page controls is pure noise. The
  // menu is still reachable via right-click or the button itself.
  handle.tabIndex = -1
  Object.assign(handle.style, {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: '#2E2A26',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: '1',
    padding: '0 4px',
  })
  bar.appendChild(handle)
  return bar
}

function setChromeTitle(chrome: HTMLElement, displayTitle: string, pin: Pin): void {
  const title = chrome.querySelector<HTMLElement>('.dom-pin-chrome-title')
  if (!title) return
  title.textContent = displayTitle
  title.title = chromeTooltip(pin, displayTitle)
  applyChromeTitleCasing(title, displayTitle, pin.slug)
}

/** Small-caps + letter-spacing is the portolan title treatment — it flatters
 *  lowercase slugs (`tapestry-dissolves` → `TAPESTRY-DISSOLVES`) but reads as
 *  shouty when applied to human-shaped titles: fiber frontmatter names
 *  ("Pin any file type"), file basenames (`CLAUDE.md`), and especially long
 *  URL paths (`1200px-Cantino_planisphere_(1502).jpg`). Apply the styling
 *  only when the chrome is still showing the bare slug; drop it the moment
 *  a humanised title takes over. */
function applyChromeTitleCasing(
  title: HTMLElement,
  displayTitle: string,
  slug: string,
): void {
  const isSlug = displayTitle === slug
  title.style.fontVariant = isSlug ? 'small-caps' : 'normal'
  title.style.letterSpacing = isSlug ? '0.03em' : '0'
}

function setChromeDirty(chrome: HTMLElement, dirty: boolean): void {
  const el = chrome.querySelector<HTMLElement>('.dom-pin-chrome-dirty')
  if (!el) return
  el.style.display = dirty ? 'inline' : 'none'
}

/** SaveState mirrors vellum's FileViewerPage — `idle | saving | saved |
 *  { error }`. Chrome paints a transient line of text that fades back to
 *  empty when the state returns to idle. */
export type ChromeSaveState = 'idle' | 'saving' | 'saved' | { error: string }

function setChromeSaveState(chrome: HTMLElement, state: ChromeSaveState): void {
  const el = chrome.querySelector<HTMLElement>('.dom-pin-chrome-save-status')
  if (!el) return
  if (state === 'idle') {
    el.textContent = ''
    el.style.display = 'none'
    return
  }
  el.style.display = 'inline'
  if (state === 'saving') el.textContent = 'Saving…'
  else if (state === 'saved') el.textContent = 'Saved'
  else el.textContent = `Error: ${state.error}`
}

/** Install (or clear) the Save button's click action. `null` hides the
 *  button; anything else shows it and binds the handler. Only one handler at
 *  a time — re-calling replaces the previous binding. */
function setChromeSaveAction(
  chrome: HTMLElement,
  save: (() => Promise<void>) | null,
): void {
  const btn = chrome.querySelector<HTMLButtonElement>('.dom-pin-chrome-save')
  if (!btn) return
  // Replace the click handler each time by cloning — simpler than tracking a
  // removable listener ref across the lifetime of a pin.
  const clone = btn.cloneNode(true) as HTMLButtonElement
  btn.replaceWith(clone)
  if (!save) {
    clone.style.display = 'none'
    return
  }
  clone.style.display = 'inline-block'
  clone.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void save()
  })
  clone.addEventListener('pointerdown', (e) => { e.stopPropagation() })
}

function setChromeStatus(chrome: HTMLElement, status: FiberStatus): void {
  const el = chrome.querySelector<HTMLElement>('.dom-pin-chrome-status')
  if (!el) return
  const meta = STATUS_GLYPHS[status]
  if (!meta) return
  el.textContent = meta.glyph
  el.style.color = meta.color
  el.title = meta.label
}

function sourceKey(pin: Pin): string {
  const s = pin.source
  if (!s) return ''
  if (s.url) return `url:${s.url}`
  return `path:${s.originId}:${s.path}`
}

function renderInner(pin: Pin, url: string | null): HTMLElement {
  const kind = pin.kind ?? 'other'
  if (!url) return renderStub(pin, 'unresolved source')

  if (kind === 'pdf' || kind === 'html') {
    const iframe = document.createElement('iframe')
    iframe.src = url
    iframe.title = pin.slug
    Object.assign(iframe.style, {
      flex: '1 1 auto',
      width: '100%',
      minHeight: '0',
      border: '1px solid rgba(140, 110, 80, 0.55)',
      borderTop: 'none',
      borderBottomLeftRadius: '6px',
      borderBottomRightRadius: '6px',
      background: 'rgba(248, 240, 225, 0.97)',
      boxShadow: '0 4px 16px rgba(46, 42, 38, 0.18)',
      display: 'block',
    })
    return iframe
  }

  if (kind === 'image') {
    const img = document.createElement('img')
    img.src = url
    img.alt = titleForPin(pin)
    Object.assign(img.style, {
      flex: '1 1 auto',
      width: '100%',
      minHeight: '0',
      objectFit: 'contain',
      border: '1px solid rgba(140, 110, 80, 0.55)',
      borderTop: 'none',
      borderBottomLeftRadius: '6px',
      borderBottomRightRadius: '6px',
      background: 'rgba(248, 240, 225, 0.97)',
      boxShadow: '0 4px 16px rgba(46, 42, 38, 0.18)',
      display: 'block',
    })
    // Hotlinks (wikipedia, many CDNs) frequently reject cross-origin <img>
    // requests. A naked broken-image icon + raw slug looks worse than a
    // labelled fallback card — swap in a link-card so the pin stays useful.
    img.addEventListener('error', () => {
      const fallback = renderLinkCard(pin, url)
      img.replaceWith(fallback)
    })
    return img
  }

  // text / other → simple link card. This path is the fallback: the text-kind
  // primary path mounts vellum's FileViewerPage inline via `mountVellumSurface`
  // (see build()); we only hit it when the host didn't wire the vellum mount.
  return renderLinkCard(pin, url)
}

function renderLinkCard(pin: Pin, url: string): HTMLElement {
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  // Chrome already shows the humanised source title; repeating it here wastes
  // the body. Show an action affordance + the full URL/path in mono — visually
  // distinct from chrome and carries information the user can't otherwise see.
  const action = document.createElement('div')
  action.textContent = '↗ Open externally'
  Object.assign(action.style, {
    fontFamily: '"EB Garamond", Garamond, serif',
    fontSize: '14px',
    color: '#7A7368',
    marginBottom: '6px',
    letterSpacing: '0.02em',
  })
  const full = document.createElement('div')
  const rawSource = pin.source?.path ?? pin.source?.url ?? url
  full.textContent = decodeSafely(rawSource)
  Object.assign(full.style, {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '11px',
    color: '#2E2A26',
    // `overflow-wrap: anywhere` lets long URLs wrap at slashes and hyphens
    // first, falling back to mid-segment breaks only when a run has no soft
    // boundary. `word-break: break-all` ignores these opportunities and
    // produces ragged, mid-word splits even when cleaner breaks exist.
    overflowWrap: 'anywhere',
    lineHeight: '1.4',
  })
  a.appendChild(action)
  a.appendChild(full)
  Object.assign(a.style, {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    flex: '1 1 auto',
    minHeight: '0',
    padding: '12px 18px',
    color: '#2E2A26',
    textDecoration: 'none',
    background: 'rgba(248, 240, 225, 0.97)',
    border: '1px solid rgba(140, 110, 80, 0.55)',
    borderTop: 'none',
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
    boxShadow: '0 4px 16px rgba(46, 42, 38, 0.18)',
  })
  return a
}

function renderStub(pin: Pin, reason: string): HTMLElement {
  const div = document.createElement('div')
  div.textContent = `${pin.slug} (${reason})`
  Object.assign(div.style, {
    flex: '1 1 auto',
    minHeight: '0',
    padding: '8px 12px',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '12px',
    color: '#7A7368',
    background: 'rgba(248, 240, 225, 0.85)',
    border: '1px dashed rgba(140, 110, 80, 0.55)',
    borderTop: 'none',
    borderBottomLeftRadius: '4px',
    borderBottomRightRadius: '4px',
  })
  return div
}

function renderResizeHandle(corner: Corner): HTMLElement {
  const h = document.createElement('div')
  h.className = `dom-pin-resize dom-pin-resize--${corner}`
  h.title = 'Drag to resize · hold Shift to lock aspect ratio'
  // Hit area is 18×18 at each corner so all four are forgiving but don't
  // crowd small cards. The visible affordance is a faint parchment dot,
  // applied via CSS so the four-corner layout reads as quiet marks rather
  // than heavy grips — constitution's "quiet by default." See the ruleset
  // in `ensurePulseStyles`.
  const style: Partial<CSSStyleDeclaration> = {
    position: 'absolute',
    width: '18px',
    height: '18px',
    cursor: cornerCursor(corner),
    touchAction: 'none',
    zIndex: '2',
  }
  if (corner === 'nw' || corner === 'sw') style.left = '0'
  else style.right = '0'
  if (corner === 'nw' || corner === 'ne') style.top = '0'
  else style.bottom = '0'
  Object.assign(h.style, style)
  return h
}

function resolveSize(pin: Pin): KindSize {
  const base = DEFAULT_SIZE[pin.kind ?? 'other'] ?? DEFAULT_SIZE.other
  const w = clampSize(pin.width ?? base.width)
  const h = clampSize(pin.height ?? base.height)
  return { width: w, height: h }
}

function clampSize(n: number): number {
  if (!Number.isFinite(n)) return MIN_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n))
}

