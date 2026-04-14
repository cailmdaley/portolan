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

const DOM_KINDS: ReadonlySet<PinKind> = new Set(['pdf', 'html', 'image', 'markdown', 'other'])

// Reference zoom (camera half-width in world units) at which a DOM pin renders
// at its intrinsic CSS size — i.e. scale = 1. Picked near the middle of the
// effective zoom range (Camera clamps to [2, 15]) so PDFs render at "natural"
// readable size at a typical city-level view, then shrink as you pull out and
// grow as you push in. Matches the spatial-scale behavior of three.js
// `PinRenderer` cards under orthographic zoom. See tapestry-dissolves Open Q (c).
const REFERENCE_ZOOM = 8

/** True if a pin should render via the DOM layer rather than PinRenderer. */
export function isDomPinKind(pin: Pin): boolean {
  if (!pin.kind) return false
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

export interface DomPinLayerOptions {
  camera: Camera
  /** Map a pin's `source` into a fetchable URL. Returns null when the source
   *  can't be resolved (unknown originId, missing fields, etc.) — the pin is
   *  rendered as a stub placeholder so the user still sees it on the map. */
  resolveSource: (pin: Pin) => string | null
  /** Right-click on a DOM pin → host opens a context menu (unpin, …). */
  onContextMenu?: (slug: string, clientX: number, clientY: number) => void
  /** Inline vellum mount for markdown (and future fiber) pins. */
  mountVellumSurface?: MountVellumFileSurface
  /** Default cityId threaded into vellum mounts when a pin lacks an originId hint. */
  cityIdFor?: () => string | undefined
}

interface DomPinEntry {
  slug: string
  pin: Pin
  el: HTMLDivElement
  inner: HTMLElement
  hovered: boolean
  vellumMount: VellumSurfaceMount | null
}

export class DomPinLayer {
  private readonly camera: Camera
  private readonly resolveSource: (pin: Pin) => string | null
  private readonly onContextMenu?: (slug: string, clientX: number, clientY: number) => void
  private readonly mountVellumSurface?: MountVellumFileSurface
  private readonly cityIdFor?: () => string | undefined
  private readonly container: HTMLDivElement
  private readonly entries = new Map<string, DomPinEntry>()
  private hoveredSlug: string | null = null

  constructor(opts: DomPinLayerOptions) {
    this.camera = opts.camera
    this.resolveSource = opts.resolveSource
    this.onContextMenu = opts.onContextMenu
    this.mountVellumSurface = opts.mountVellumSurface
    this.cityIdFor = opts.cityIdFor

    this.container = document.createElement('div')
    this.container.className = 'dom-pin-layer'
    Object.assign(this.container.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '20',
    })
    document.body.appendChild(this.container)
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
    })

    // Chrome strip — a pointer-event handle that stays *outside* the iframe's
    // own event scope. Right-click or clicking the ⋮ opens the host context
    // menu; dragging/scrolling the iframe below never reaches the wrapper, so
    // this strip is the only reliable unpin affordance for iframe-backed pins
    // (PDF/HTML). See tapestry-dissolves: "right-click unpin from a PDF that
    // swallows pointer events."
    const chrome = renderChrome(pin)
    el.appendChild(chrome)

    let vellumMount: VellumSurfaceMount | null = null
    let inner: HTMLElement
    if (pin.kind === 'markdown' && pin.source?.path && this.mountVellumSurface) {
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
    return { slug: pin.slug, pin, el, inner, hovered: false, vellumMount }
  }
}

function renderVellumShell(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'dom-pin-vellum-shell'
  Object.assign(div.style, {
    width: '420px',
    height: '420px',
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

function renderChrome(pin: Pin): HTMLElement {
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
  title.textContent = pin.slug
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
      width: kind === 'pdf' ? '320px' : '420px',
      height: kind === 'pdf' ? '420px' : '300px',
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
      maxWidth: '320px',
      maxHeight: '320px',
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
    display: 'block',
    padding: '12px 18px',
    minWidth: '160px',
    maxWidth: '320px',
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
