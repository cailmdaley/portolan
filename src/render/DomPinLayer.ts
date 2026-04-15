// DomPinLayer.ts - DOM-overlay surface for non-fiber pinned files.
//
// Companion to PinRenderer (which owns three.js card surfaces for fiber pins).
// Where the canvas card is a single texture, these are real DOM nodes —
// iframes for PDFs and HTML, <img> for raster images, etc. — anchored to
// world-space `{x, z}` and reanchored each frame via Camera.worldToScreen.
//
// Sits in a sibling overlay above the canvas. Wrapper is `pointer-events: none`
// so empty space falls through to the map; each pin element opts back in to
// `pointer-events: auto`. PinRenderer skips slugs the DOM layer owns; main.ts
// routes by `pin.kind` (fiber → PinRenderer, everything else → here).
//
// See fiber `tapestry-dissolves`, open question 3 (`pin-any-file-type`).

import type { Camera } from './Camera'
import type { Pin, PinKind } from '../state/layoutClient'

const DOM_KINDS: ReadonlySet<PinKind> = new Set([
  'fiber', 'pdf', 'html', 'image', 'markdown', 'other',
])

// Reference zoom (camera half-width in world units) at which a DOM pin renders
// at its intrinsic CSS size — i.e. scale = 1. Picked near the middle of the
// effective zoom range (Camera clamps to [2, 15]) so PDFs render at "natural"
// readable size at a typical city-level view, then shrink as you pull out and
// grow as you push in. Matches the spatial-scale behavior of three.js
// `PinRenderer` cards under orthographic zoom. See tapestry-dissolves Open Q (c).
const REFERENCE_ZOOM = 8

/** Kind-specific default intrinsic CSS sizes — applied when a pin has no
 *  persisted width/height. Matches the pre-existing inline iframe/img defaults
 *  below, so pins that pre-date size-persistence render at identical size. */
interface KindSize { width: number; height: number }
const DEFAULT_SIZE: Record<PinKind, KindSize> = {
  fiber: { width: 320, height: 320 },
  markdown: { width: 420, height: 420 },
  pdf: { width: 320, height: 420 },
  html: { width: 420, height: 300 },
  image: { width: 320, height: 320 },
  other: { width: 260, height: 120 },
}
const MIN_SIZE = 120
const MAX_SIZE = 1600

/** True if a pin should render via the DOM layer. All kinds route to DOM. */
export function isDomPinKind(pin: Pin): boolean {
  return DOM_KINDS.has(pin.kind)
}

/**
 * Mount a vellum file surface (FileViewerPage) into a host container. Optional
 * — when provided, markdown pins render their content inline via vellum
 * instead of falling back to the link-card stub. See [[file-view-as-floating-card]].
 */
export interface VellumSurfaceMount {
  unmount(): void
}

export type MountVellumFileSurface = (
  container: HTMLElement,
  opts: { path: string; originId?: string; cityId?: string },
) => VellumSurfaceMount

/**
 * Inline vellum mount for fiber-kind DOM pins. Renders vellum's FiberCard
 * with fetched body; see `tapestry-dissolves` Next and [[file-view-as-floating-card]].
 */
export type MountVellumFiberSurface = (
  container: HTMLElement,
  opts: { slug: string; cityId?: string; originId?: string },
) => VellumSurfaceMount

export interface DomPinLayerOptions {
  camera: Camera
  /** Map a pin's `source` into a fetchable URL. Returns null when the source
   *  can't be resolved (unknown originId, missing fields, etc.) — the pin is
   *  rendered as a stub placeholder so the user still sees it on the map. */
  resolveSource: (pin: Pin) => string | null
  /** Right-click on a DOM pin → host opens a context menu (unpin, …). */
  onContextMenu?: (slug: string, clientX: number, clientY: number) => void
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
}

interface DomPinEntry {
  slug: string
  pin: Pin
  el: HTMLDivElement
  inner: HTMLElement
  hovered: boolean
  dragging: boolean
  vellumMount: VellumSurfaceMount | null
  width: number
  height: number
}

export class DomPinLayer {
  private readonly camera: Camera
  private readonly resolveSource: (pin: Pin) => string | null
  private readonly onContextMenu?: (slug: string, clientX: number, clientY: number) => void
  private readonly mountVellumSurface?: MountVellumFileSurface
  private readonly mountVellumFiberSurface?: MountVellumFiberSurface
  private readonly cityIdFor?: () => string | undefined
  private readonly screenToWorld?: (x: number, y: number) => { x: number; z: number }
  private readonly onPinMoved?: (slug: string, x: number, z: number) => void
  private readonly onPinResized?: (slug: string, width: number, height: number) => void
  private readonly container: HTMLDivElement
  private readonly entries = new Map<string, DomPinEntry>()
  private hoveredSlug: string | null = null

  constructor(opts: DomPinLayerOptions) {
    this.camera = opts.camera
    this.resolveSource = opts.resolveSource
    this.onContextMenu = opts.onContextMenu
    this.mountVellumSurface = opts.mountVellumSurface
    this.mountVellumFiberSurface = opts.mountVellumFiberSurface
    this.cityIdFor = opts.cityIdFor
    this.screenToWorld = opts.screenToWorld
    this.onPinMoved = opts.onPinMoved
    this.onPinResized = opts.onPinResized

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
          applySize(existing)
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
      if (prev) {
        prev.hovered = false
        prev.el.classList.remove('dom-pin--hovered')
      }
    }
    this.hoveredSlug = slug
    if (slug) {
      const entry = this.entries.get(slug)
      if (entry) {
        entry.hovered = true
        entry.el.classList.add('dom-pin--hovered')
      }
    }
  }

  private position(entry: DomPinEntry): void {
    const { x, y } = this.camera.worldToScreen(entry.pin.x, 0.05, entry.pin.z)
    const zoom = this.camera.cameraDistance
    const scale = REFERENCE_ZOOM / Math.max(zoom, 0.0001)
    // CSS transform centers the pin on its anchor, then scales around that
    // center so the DOM card grows/shrinks together with the canvas pins as
    // the camera zooms.
    entry.el.style.transform =
      `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale.toFixed(4)})`
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
      transition: 'transform 80ms linear',
      display: 'flex',
      flexDirection: 'column',
      // Intrinsic size lives on the wrapper; inner bodies fill it via flex:1.
      // Camera-zoom scale is applied by `position()` and multiplies these.
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

    let vellumMount: VellumSurfaceMount | null = null
    let inner: HTMLElement
    if (pin.kind === 'fiber' && this.mountVellumFiberSurface) {
      inner = renderVellumShell()
      vellumMount = this.mountVellumFiberSurface(inner, {
        slug: pin.slug,
        cityId: this.cityIdFor?.(),
      })
    } else if (pin.kind === 'markdown' && pin.source?.path && this.mountVellumSurface) {
      inner = renderVellumShell()
      vellumMount = this.mountVellumSurface(inner, {
        path: pin.source.path,
        originId: pin.source.originId,
        cityId: this.cityIdFor?.(),
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
      hovered: false,
      dragging: false,
      vellumMount,
      width: size.width,
      height: size.height,
    }
    applySize(entry)
    this.attachChromeDrag(chrome, entry)
    this.attachChromeScale(chrome, entry)
    // Resize handle lives above the inner body so it stays above iframe event
    // scope. Dragging it updates width/height live and commits on release.
    const resizeHandle = renderResizeHandle()
    el.appendChild(resizeHandle)
    this.attachResize(resizeHandle, entry)
    return entry
  }

  /** Scroll-wheel over the chrome strip scales the card's intrinsic size. The
   *  chrome is a DOM sibling of the canvas, so camera-wheel never fires here —
   *  but we still stopPropagation/preventDefault so page-level scroll doesn't
   *  kick in. Gentle exponential scale matches the camera zoom feel; commit is
   *  debounced so a wheel gesture fires one persisted write on release, not one
   *  per tick. See [[file-view-as-floating-card]]: zoom-over-header. */
  private attachChromeScale(chrome: HTMLElement, entry: DomPinEntry): void {
    if (!this.onPinResized) return
    const STEP_IN = 1.05
    const STEP_OUT = 1 / STEP_IN
    let commitTimer: number | null = null
    chrome.addEventListener('wheel', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const factor = event.deltaY > 0 ? STEP_OUT : STEP_IN
      entry.width = clampSize(entry.width * factor)
      entry.height = clampSize(entry.height * factor)
      applySize(entry)
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
      let active = false

      const onMove = (ev: PointerEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return
          active = true
          entry.dragging = true
          entry.el.classList.add('dom-pin--dragging')
          entry.el.style.transition = 'none'
          chrome.style.cursor = 'grabbing'
          document.body.style.cursor = 'grabbing'
          // Reuse the drag-to-pin suppression flag so MapInteractionController's
          // canvas-hover early-returns apply to chrome-strip drags too.
          document.body.classList.add('pin-dragging')
        }
        const world = this.screenToWorld!(ev.clientX, ev.clientY)
        entry.pin = { ...entry.pin, x: world.x, z: world.z }
        this.position(entry)
      }

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        if (!active) return
        entry.dragging = false
        entry.el.classList.remove('dom-pin--dragging')
        entry.el.style.transition = 'transform 80ms linear'
        chrome.style.cursor = 'grab'
        document.body.style.cursor = ''
        document.body.classList.remove('pin-dragging')
        // Commit final world position. Read from the last pointer event
        // because `entry.pin` was updated per-move above.
        const world = this.screenToWorld!(ev.clientX, ev.clientY)
        this.onPinMoved!(entry.slug, world.x, world.z)
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)

      event.preventDefault()
      event.stopPropagation()
    })
  }

  /** Wire pointerdown on the bottom-right resize handle into a drag that scales
   *  the card's intrinsic size. Screen-pixel deltas are divided by the current
   *  camera-zoom scale so one screen pixel of drag equals one CSS pixel of
   *  size change (otherwise resizing would feel faster/slower at different
   *  zoom levels). Commits via `onPinResized`; skipped if the host didn't
   *  provide the callback. */
  private attachResize(handle: HTMLElement, entry: DomPinEntry): void {
    if (!this.onPinResized) return

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startY = event.clientY
      const startW = entry.width
      const startH = entry.height
      const zoom = this.camera.cameraDistance
      const scale = REFERENCE_ZOOM / Math.max(zoom, 0.0001)
      let active = false

      const onMove = (ev: PointerEvent) => {
        const dxScreen = ev.clientX - startX
        const dyScreen = ev.clientY - startY
        if (!active) {
          if (Math.hypot(dxScreen, dyScreen) < 2) return
          active = true
          entry.el.classList.add('dom-pin--resizing')
          entry.el.style.transition = 'none'
          document.body.style.cursor = 'nwse-resize'
          // Reuse the same suppression flag as drag-to-pin / chrome-drag so
          // pin-hover and canvas interactions don't interfere mid-resize.
          document.body.classList.add('pin-dragging')
        }
        entry.width = clampSize(startW + dxScreen / scale)
        entry.height = clampSize(startH + dyScreen / scale)
        applySize(entry)
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        if (!active) return
        entry.el.classList.remove('dom-pin--resizing')
        entry.el.style.transition = 'transform 80ms linear'
        document.body.style.cursor = ''
        document.body.classList.remove('pin-dragging')
        this.onPinResized!(entry.slug, entry.width, entry.height)
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)

      event.preventDefault()
      event.stopPropagation()
    })
  }
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

/** Derive a human-readable chrome-strip title from a DOM pin's source.
 *  Fiber pins never reach this layer; for file handles we show the basename,
 *  for URLs the hostname, and for unresolved/empty sources the raw slug. */
function titleForPin(pin: Pin): string {
  const s = pin.source
  if (!s) return pin.slug
  if (s.path) {
    const base = s.path.split('/').filter(Boolean).pop()
    if (base) return base
  }
  if (s.url) {
    try {
      const u = new URL(s.url)
      const path = u.pathname.replace(/\/$/, '')
      const base = path ? path.split('/').filter(Boolean).pop() : ''
      return base ? `${u.hostname} / ${base}` : u.hostname
    } catch {
      return s.url
    }
  }
  return pin.slug
}

function renderChrome(pin: Pin, displayTitle: string): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'dom-pin-chrome'
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
  const title = document.createElement('span')
  title.className = 'dom-pin-chrome-title'
  title.textContent = displayTitle
  title.title = `${displayTitle} · ${pin.slug}`
  Object.assign(title.style, {
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontVariant: 'small-caps',
    letterSpacing: '0.03em',
  })
  bar.appendChild(title)
  const handle = document.createElement('button')
  handle.type = 'button'
  handle.className = 'dom-pin-menu-handle'
  handle.textContent = '⋮'
  handle.title = 'Pin menu'
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
    img.alt = pin.slug
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
    return img
  }

  // markdown / other → simple link card. Markdown isn't rendered inline (yet);
  // the user sees a labeled card and can click through to open it.
  return renderLinkCard(pin, url)
}

function renderLinkCard(pin: Pin, url: string): HTMLElement {
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.textContent = pin.slug
  Object.assign(a.style, {
    display: 'flex',
    alignItems: 'center',
    flex: '1 1 auto',
    minHeight: '0',
    padding: '12px 18px',
    fontFamily: '"EB Garamond", Garamond, serif',
    fontSize: '18px',
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

function renderResizeHandle(): HTMLElement {
  const h = document.createElement('div')
  h.className = 'dom-pin-resize'
  Object.assign(h.style, {
    position: 'absolute',
    right: '0',
    bottom: '0',
    width: '14px',
    height: '14px',
    cursor: 'nwse-resize',
    background:
      'linear-gradient(135deg, transparent 0%, transparent 50%, rgba(140, 110, 80, 0.55) 50%, rgba(140, 110, 80, 0.55) 65%, transparent 65%, transparent 75%, rgba(140, 110, 80, 0.55) 75%, rgba(140, 110, 80, 0.55) 90%, transparent 90%)',
    touchAction: 'none',
    zIndex: '2',
  })
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

function applySize(entry: DomPinEntry): void {
  entry.el.style.width = `${entry.width}px`
  entry.el.style.height = `${entry.height}px`
}
