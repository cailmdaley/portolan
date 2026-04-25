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
import { trackWheelEvent } from './wheelGesture'

const DOM_KINDS: ReadonlySet<PinKind> = new Set([
  'fiber', 'pdf', 'html', 'image', 'text', 'other', 'terminal',
])

/** Retained only for `resolveFiberMeta`'s callback typing — the pin no longer
 *  paints a status glyph of its own. Vellum's FiberCard pretext surfaces the
 *  fiber's status inside the reader; the map itself stays quiet. */
export type FiberStatus = 'open' | 'active' | 'closed'

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
  // Terminal pins default to a size that shows ~80 cols × 20 rows at the
  // wterm font metrics — wide enough to keep Claude Code's boxed messages
  // from wrapping catastrophically at the `REFERENCE_ZOOM` baseline.
  terminal: { width: 640, height: 320 },
}
// Minimum is tiny — just a numerical floor so the box never collapses to
// zero / negative. `position()` also clamps CSS size to ≥8px.
const MIN_SIZE = 8
const MAX_SIZE = 1600
// At or below this rendered width (CSS px) the pin transitions from *card*
// (chrome + body) to *label* (parchment tab, filename only). See crafting
// session 2026-04-18 — the narrow-width pin is a different primitive, not a
// collapsed card.
const LABEL_THRESHOLD = 140

type Handle = 'n' | 'e' | 's' | 'w' | 'ne' | 'se' | 'sw' | 'nw'
const HANDLES: readonly Handle[] = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']
function handleSigns(h: Handle): { sx: 0 | 1 | -1; sz: 0 | 1 | -1 } {
  const sx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0
  const sz = h.includes('s') ? 1 : h.includes('n') ? -1 : 0
  return { sx, sz }
}

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
  },
) => VellumSurfaceMount

/**
 * Inline vellum mount for fiber-kind DOM pins. Renders vellum's FiberCard
 * with fetched body; see `tapestry-dissolves` Next and [[file-view-as-floating-card]].
 */
export type MountVellumFiberSurface = (
  container: HTMLElement,
  opts: {
    slug: string
    cityId?: string
    originId?: string
    width?: number
    /** Wikilink-click handler. Forwarded into vellum's FiberCard `onNavigate`
     *  so clicks on `/<slug>` anchors call back into the host instead of the
     *  browser trying to navigate. */
    onNavigate?: (slug: string) => void
  },
) => VellumSurfaceMount

/** Mount a read-only terminal view into `container` for the given sessionId.
 *  Returns an unmount callback. See [[constitution-terminals-in-map]].
 *
 *  `setIntrinsicSize` lets the mount request a pin-size bump once it learns
 *  the tmux pane's real column/row count (the first `terminal:scrollback`
 *  frame carries it). The arguments are *CSS* pixels at the current zoom —
 *  the layer back-computes the intrinsic from `zoomRatio`, so the ask is
 *  stable regardless of camera distance. The layer only honours the request
 *  while the pin is still at its kind default — once the user resizes, their
 *  choice wins. Without this, a narrower default pin displays scrollback laid
 *  out for a wider pane as a staircase. See [[wterm-col-width-mismatch]]. */
export type MountTerminalSurface = (
  container: HTMLElement,
  opts: {
    sessionId: string
    setIntrinsicSize?: (cssWidth: number, cssHeight: number) => void
  },
) => VellumSurfaceMount

export interface DomPinLayerOptions {
  camera: Camera
  /** Map a pin's `source` into a fetchable URL. Returns null when the source
   *  can't be resolved (unknown originId, missing fields, etc.) — the pin is
   *  rendered as a stub placeholder so the user still sees it on the map. */
  resolveSource: (pin: Pin) => string | null
  /** Right-click on a DOM pin → host opens a context menu (unpin, …). */
  onContextMenu?: (slug: string, clientX: number, clientY: number) => void
  /** Click on the chrome's × button → host unpins. Surfaces the primary destructive
   *  action at the card's top-right so the user doesn't have to open the ⋮ menu. */
  onClose?: (slug: string) => void
  /** Double-click on the chrome strip → host opens the pin's primary surface
   *  (fiber workspace, vellum file modal, external URL — whatever "Open" means
   *  for this kind). Discoverability shortcut so the Open action doesn't live
   *  behind right-click only. */
  onPrimaryOpen?: (slug: string) => void
  /** Inline vellum mount for markdown file pins. */
  mountVellumSurface?: MountVellumFileSurface
  /** Inline vellum mount for fiber pins (renders vellum's FiberCard). */
  mountVellumFiberSurface?: MountVellumFiberSurface
  /** Inline wterm mount for terminal pins. Optional — when absent, terminal
   *  pins render as the link-card stub (same fallback as other unsupported
   *  kinds). See [[constitution-terminals-in-map]]. */
  mountTerminalSurface?: MountTerminalSurface
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
  /** Wikilink click inside a fiber pin's body. Receives the target slug stripped
   *  of its leading slash (e.g. clicking `[[swarm]]` calls with `"swarm"`).
   *  Without a handler the click is a no-op — FiberCard's `onNavigate` only
   *  preventDefaults when a callback is wired. The host typically spawns or
   *  pulses a fiber pin for the slug at the current city. */
  onFiberNavigate?: (slug: string) => void
}

interface DomPinEntry {
  slug: string
  pin: Pin
  el: HTMLDivElement
  inner: HTMLElement
  /** Minimal label-tab element shown when the pin narrows past LABEL_THRESHOLD.
   *  Hidden when the card is rendering its full reader surface. Carries just
   *  the pin's title so a distant map still reads at a glance. */
  labelTab: HTMLElement
  vellumMount: VellumSurfaceMount | null
  /** Intrinsic world size — persisted as `pin.width`/`height`. Interpreted as
   *  CSS pixels at `REFERENCE_ZOOM`; the per-frame CSS size is this × the
   *  current zoom ratio. See constitution invariant 1. */
  width: number
  height: number
  /** Last CSS width passed to `vellumMount.resize()`. Used to gate reflow
   *  calls so React doesn't re-render every frame during a pan. */
  lastReflowWidth: number
  /** Whether this entry is currently rendered in label mode (CSS width ≤
   *  LABEL_THRESHOLD). Stored on the entry so `position()` can detect
   *  transitions without re-reading a stale previous CSS value. Drives
   *  lazy-attach for terminal pins — the wterm mount only exists while the
   *  pin is above the threshold. See constitution "Lazy attach" scope
   *  decision. */
  isLabel: boolean
  lastCssWidth: number
  lastCssHeight: number
  lastScreenX: number
  lastScreenY: number
}

export class DomPinLayer {
  private readonly camera: Camera
  private readonly resolveSource: (pin: Pin) => string | null
  private readonly onContextMenu?: (slug: string, clientX: number, clientY: number) => void
  private readonly onClose?: (slug: string) => void
  private readonly onPrimaryOpen?: (slug: string) => void
  private readonly mountVellumSurface?: MountVellumFileSurface
  private readonly mountVellumFiberSurface?: MountVellumFiberSurface
  private readonly mountTerminalSurface?: MountTerminalSurface
  private readonly cityIdFor?: () => string | undefined
  private readonly screenToWorld?: (x: number, y: number) => { x: number; z: number }
  private readonly onPinMoved?: (slug: string, x: number, z: number) => void
  private readonly onPinResized?: (slug: string, width: number, height: number) => void
  private readonly resolveFiberMeta?: (pin: Pin) => Promise<{ name?: string | null; status?: FiberStatus | null } | null>
  private readonly onHover?: (slug: string | null) => void
  private readonly onFiberNavigate?: (slug: string) => void
  private readonly container: HTMLDivElement
  private readonly entries = new Map<string, DomPinEntry>()
  private hoveredSlug: string | null = null
  /** Pin slugs currently under a pointer (own-hover, not the HUD bridge). The
   *  layer's container z-index escapes the HUD sidebar (z=900) and recent-worker
   *  bar (z=50) while non-empty so a pin partly behind those panels still has
   *  reachable affordances. See [[pin-affordances-occluded-by-hud]]. */
  private readonly pointerOver = new Set<string>()
  private zCounter = 0

  constructor(opts: DomPinLayerOptions) {
    this.camera = opts.camera
    this.resolveSource = opts.resolveSource
    this.onContextMenu = opts.onContextMenu
    this.onClose = opts.onClose
    this.onPrimaryOpen = opts.onPrimaryOpen
    this.mountVellumSurface = opts.mountVellumSurface
    this.mountVellumFiberSurface = opts.mountVellumFiberSurface
    this.mountTerminalSurface = opts.mountTerminalSurface
    this.cityIdFor = opts.cityIdFor
    this.screenToWorld = opts.screenToWorld
    this.onPinMoved = opts.onPinMoved
    this.onPinResized = opts.onPinResized
    this.resolveFiberMeta = opts.resolveFiberMeta
    this.onHover = opts.onHover
    this.onFiberNavigate = opts.onFiberNavigate

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

  /** Mark a pin as pointer-over (or not) and float the whole pin layer above
   *  the HUD sidebar / recent-worker bar while any pin is under the cursor.
   *  The layer is otherwise z=20 (above map, below the HUD chrome at z=900) so
   *  pins read as map objects; promoting on hover keeps the chrome panels
   *  authoritative most of the time but lets a pin partly tucked behind them
   *  surface its ×/⋮ affordances when the user reaches for them.
   *  See [[pin-affordances-occluded-by-hud]]. */
  private setPointerOver(slug: string, over: boolean): void {
    if (over) this.pointerOver.add(slug)
    else this.pointerOver.delete(slug)
    this.container.style.zIndex = this.pointerOver.size > 0 ? '950' : '20'
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
    // A pin removed mid-hover (e.g. user clicks ×) never fires pointerleave.
    // Drop it explicitly so the layer doesn't strand at z=950.
    if (this.pointerOver.has(slug)) this.setPointerOver(slug, false)
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
    if (cssW !== entry.lastCssWidth) {
      entry.el.style.width = `${cssW}px`
      entry.lastCssWidth = cssW
    }
    // Below the label threshold the pin switches to a different primitive —
    // a parchment label that IS just the filename, not a card with a hidden
    // body. The outer element shrinks to chrome height so there's no
    // hollow transparent box beneath the title.
    const isLabel = cssW <= LABEL_THRESHOLD
    if (isLabel) {
      if (!entry.isLabel || cssH !== entry.lastCssHeight) {
        entry.el.style.height = 'auto'
      }
      if (!entry.isLabel) entry.el.classList.add('dom-pin--label')
    } else {
      if (cssH !== entry.lastCssHeight || entry.isLabel) {
        entry.el.style.height = `${cssH}px`
      }
      if (entry.isLabel) entry.el.classList.remove('dom-pin--label')
    }
    // Terminal pins lazy-attach: the wterm mount (and its server-side
    // `tmux -CC` refcount) exists only while the pin is above the label
    // threshold. Collapsing into label mode tears it down; expanding past
    // remounts a fresh wterm + replays scrollback. Fires only on the edge
    // so per-frame reanchoring doesn't thrash the mount. See constitution
    // "Lazy attach" scope decision.
    if (isLabel !== entry.isLabel) {
      const wasLabel = entry.isLabel
      entry.isLabel = isLabel
      if (entry.pin.kind === 'terminal' && entry.pin.source?.sessionId && this.mountTerminalSurface) {
        if (isLabel) {
          entry.vellumMount?.unmount()
          entry.vellumMount = null
          entry.lastReflowWidth = 0
        } else {
          entry.vellumMount = this.mountTerminalSurface(entry.inner, {
            sessionId: entry.pin.source.sessionId,
            setIntrinsicSize: (w, h) => this.setIntrinsicSizeIfPristine(entry.slug, w, h),
          })
        }
      } else if (entry.pin.kind === 'fiber' && this.mountVellumFiberSurface) {
        if (isLabel) {
          entry.vellumMount?.unmount()
          entry.vellumMount = null
          entry.lastReflowWidth = 0
        } else if (wasLabel) {
          entry.vellumMount = this.mountVellumFiberSurface(entry.inner, {
            slug: entry.slug,
            cityId: this.cityIdFor?.(),
            width: entry.width,
            onNavigate: this.onFiberNavigate,
          })
        }
      }
    }
    entry.lastCssHeight = cssH
    if (x !== entry.lastScreenX || y !== entry.lastScreenY) {
      entry.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
      entry.lastScreenX = x
      entry.lastScreenY = y
    }
    // Notify fiber mounts when the projected width crossed a meaningful
    // threshold so FiberCard's pretext reflows with the card, without
    // thrashing React every frame during a pan.
    if (entry.vellumMount?.resize && Math.abs(cssW - entry.lastReflowWidth) >= 8) {
      entry.lastReflowWidth = cssW
      entry.vellumMount.resize(cssW)
    }
  }

  /** Resize a pin so it renders at the given *CSS* width/height at the current
   *  zoom — the intrinsic is back-computed by dividing out `zoomRatio`, so the
   *  ask is stable whether the user is zoomed in or out. Honoured only while
   *  the pin is still at its kind default; once the user drags a resize
   *  handle, the pin diverges from the default and this method is a no-op.
   *
   *  Terminal mounts use this to fit exactly the tmux pane's cols×rows worth
   *  of wterm grid on first scrollback, avoiding the mid-word staircase that
   *  shows up when the CSS container is narrower than the layout the bytes
   *  were produced for. See [[wterm-col-width-mismatch]]. */
  private setIntrinsicSizeIfPristine(slug: string, cssWidth: number, cssHeight: number): void {
    const entry = this.entries.get(slug)
    if (!entry) return
    const defaults = DEFAULT_SIZE[entry.pin.kind ?? 'other'] ?? DEFAULT_SIZE.other
    if (entry.width !== defaults.width || entry.height !== defaults.height) return
    const ratio = this.zoomRatio()
    entry.width = clampSize(cssWidth / ratio)
    entry.height = clampSize(cssHeight / ratio)
    this.position(entry)
    this.onPinResized?.(slug, entry.width, entry.height)
  }

  private zoomRatio(): number {
    return REFERENCE_ZOOM / Math.max(this.camera.cameraDistance, 0.0001)
  }

  private build(pin: Pin): DomPinEntry {
    const url = this.resolveSource(pin)
    const el = document.createElement('div')
    el.className = `dom-pin dom-pin--${pin.kind ?? 'other'}`
    el.dataset.slug = pin.slug
    // A11y: name the pin by what it holds, not by the concatenated text
    // content of its inner surfaces (which picks up "Save", line-number
    // gutter digits, and the first bytes of code). `role="region"` gives
    // the snapshot tree a named landmark per pin instead of a nameless
    // `generic` div swallowing up editor text. `setLabelTabTitle()`
    // refreshes both the lozenge and this label when async fiber metadata
    // arrives.
    el.setAttribute('role', 'region')
    el.setAttribute('aria-label', `${pin.kind ?? 'pin'} pin: ${titleForPin(pin)}`)
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

    // Label tab — a small parchment lozenge that becomes the whole visible pin
    // at narrow widths (below LABEL_THRESHOLD). In full-reader mode it's
    // hidden; in label mode the body/vellum/iframe is hidden and the tab is
    // the single visible surface. Carries just the pin's title so a distant
    // map still reads at a glance. See constitution invariant 5.
    const labelTab = renderLabelTab(titleForPin(pin), pin.slug)
    el.appendChild(labelTab)
    if (this.resolveFiberMeta) {
      void this.resolveFiberMeta(pin).then((meta) => {
        if (!meta) return
        if (this.entries.get(pin.slug)?.el !== el) return
        if (meta.name) {
          setLabelTabTitle(labelTab, meta.name, pin.slug)
          el.setAttribute('aria-label', `${pin.kind ?? 'pin'} pin: ${meta.name}`)
          // Affordance buttons were labelled with `titleForPin(pin)` (the
          // slug for fiber kind) at first paint. Now that the fiber's real
          // name has resolved, swap the qualifier so screen-readers and the
          // a11y snapshot read the same human title the region carries.
          const menuBtn = el.querySelector<HTMLElement>('.dom-pin-affordance-menu')
          const closeBtn = el.querySelector<HTMLElement>('.dom-pin-affordance-close')
          if (menuBtn) {
            menuBtn.setAttribute('aria-label', `Pin menu for ${meta.name}`)
            menuBtn.title = `Pin menu for ${meta.name}`
          }
          if (closeBtn) {
            closeBtn.setAttribute('aria-label', `Unpin ${meta.name}`)
            closeBtn.title = `Unpin ${meta.name}`
          }
        }
      }).catch(() => {})
    }

    let vellumMount: VellumSurfaceMount | null = null
    let inner: HTMLElement
    // Predict label mode at the current zoom so terminal pins don't waste a
    // wterm instance + server attach on a pin that's going to be a label on
    // its first frame. See constitution "Lazy attach" scope decision and
    // `position()` for the transition logic.
    const initialCssW = Math.max(8, size.width * this.zoomRatio())
    const initialIsLabel = initialCssW <= LABEL_THRESHOLD
    if (pin.kind === 'fiber' && this.mountVellumFiberSurface) {
      inner = renderVellumShell()
      if (!initialIsLabel) {
        vellumMount = this.mountVellumFiberSurface(inner, {
          slug: pin.slug,
          cityId: this.cityIdFor?.(),
          width: size.width,
          onNavigate: this.onFiberNavigate,
        })
      }
    } else if (pin.kind === 'terminal' && pin.source?.sessionId && this.mountTerminalSurface) {
      // Read-only wterm view of a live tmux pane. The card frame is reused
      // (resize handles, drag behaviors); the body is the terminal grid.
      // See [[constitution-terminals-in-map]]. When the pin starts in label
      // mode the shell is created empty and wterm mounts lazily in
      // `position()` on the first expansion past LABEL_THRESHOLD.
      inner = renderTerminalShell()
      if (!initialIsLabel) {
        vellumMount = this.mountTerminalSurface(inner, {
          sessionId: pin.source.sessionId,
          setIntrinsicSize: (w, h) => this.setIntrinsicSizeIfPristine(pin.slug, w, h),
        })
      }
    } else if (pin.kind === 'text' && pin.source?.path && this.mountVellumSurface) {
      inner = renderVellumShell()
      // Card ↔ modal parity: the card mounts the same vellum FileViewerPage as
      // the modal and must expose the same edit/save surface. `openFile()` in
      // main.ts defaults modals to `editable: true`; mirror that here so cards
      // aren't a read-only second-class citizen. See [[card-modal-parity]].
      // Vellum's own toolbar renders inside the mount — dirty dot and save
      // controls included. Portolan no longer paints chrome above the reader.
      vellumMount = this.mountVellumSurface(inner, {
        path: pin.source.path,
        originId: pin.source.originId,
        cityId: this.cityIdFor?.(),
        editable: true,
      })
    } else {
      inner = renderInner(pin, url)
    }
    el.appendChild(inner)

    // Map-level affordance cluster (× close, ⋮ menu, ↗ external for URL pins).
    // Floats in the top-right of the frame, above vellum / iframe / image
    // content. Quiet at rest, full opacity on pin hover. These are *map*
    // operations, not reader ones — closing a pin and the map context menu
    // have no business inside vellum's own chrome.
    const affordances = renderAffordances(pin)
    el.appendChild(affordances)

    if (this.onContextMenu) {
      const openMenu = (clientX: number, clientY: number) => {
        this.onContextMenu?.(pin.slug, clientX, clientY)
      }
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY)
      })
      const handle = affordances.querySelector<HTMLElement>('.dom-pin-affordance-menu')
      handle?.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY)
      })
    }
    if (this.onClose) {
      const closeBtn = affordances.querySelector<HTMLElement>('.dom-pin-affordance-close')
      closeBtn?.addEventListener('pointerdown', (event) => { event.stopPropagation() })
      closeBtn?.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.onClose!(pin.slug)
      })
    }
    const entry: DomPinEntry = {
      slug: pin.slug,
      pin,
      el,
      inner,
      labelTab,
      vellumMount,
      width: size.width,
      height: size.height,
      lastReflowWidth: 0,
      isLabel: initialIsLabel,
      lastCssWidth: 0,
      lastCssHeight: 0,
      lastScreenX: Number.NaN,
      lastScreenY: Number.NaN,
    }
    // Bring-to-front on any interaction — stacked pins (e.g. a large markdown
    // card over a fiber pin) need a way to surface. Capture phase so we raise
    // before downstream drag/resize/chrome handlers consume the event.
    el.addEventListener('pointerdown', () => this.raise(entry), true)
    // Hover-raise: clicking the body to surface a pin would also fire its
    // primary-open action; pointerenter on the visible (uncovered) area
    // promotes it without that side effect, exposing the affordance cluster
    // (× close, ⋮ menu) for the pin underneath. DOM stacking means we only
    // see the event when the pointer is over uncovered pixels, which is
    // exactly when the user is targeting that pin. Suppressed during a
    // drag, since the dragged pin is already raised and we don't want
    // crossed pins to steal the front. See [[fiber-pins-overlap-at-same-coords]].
    el.addEventListener('pointerenter', () => {
      if (document.body.classList.contains('pin-dragging')) return
      this.raise(entry)
      this.setPointerOver(pin.slug, true)
    })
    // Pointerleave fires even mid-drag, which is fine — dropping the layer
    // back to z=20 just lets HUD chrome reclaim its z order once the pin is
    // no longer under the cursor. The pointerdown raise has already set the
    // dragged pin's intra-layer z-index, so the dragged pin still sits on top
    // of its siblings within the (lowered) layer.
    el.addEventListener('pointerleave', () => {
      this.setPointerOver(pin.slug, false)
    })
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
    this.attachPinDrag(el, entry)
    // One wheel handler for the whole card. Plain wheel bubbles into the
    // native overflow-scroll of whatever child owns it (vellum-shell,
    // iframes); `stopPropagation` keeps the camera from zooming in parallel.
    // Cmd/Ctrl + wheel resizes the card's intrinsic world size anywhere on
    // the card. See constitution invariant 3 and
    // `pin-resize-gesture-moves-target`.
    this.attachWheelResize(el, entry)
    if (this.onPrimaryOpen) {
      // Double-click on the frame → host's "Open" action (fiber workspace,
      // vellum modal, external URL). Gated by `isInteractiveTarget` so a
      // double-click landing inside vellum's editor, a form field, or an
      // anchor doesn't steal that gesture from the content.
      el.addEventListener('dblclick', (event) => {
        if (isInteractiveTarget(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        this.onPrimaryOpen!(entry.slug)
      })
    }
    // Four resize handles, one per edge — dragging any of them resizes one
    // dimension while the opposite edge stays pinned in world space. Handles
    // sit above iframe event scope so pdf/html pins still catch the gesture.
    // See constitution invariant 4.
    for (const h of HANDLES) {
      const handle = renderResizeHandle(h)
      el.appendChild(handle)
      this.attachResize(handle, entry, h)
    }
    return entry
  }

  /** Wheel gesture on the card.
   *
   *  Gesture ownership is arbitrated via `trackWheelEvent` — if the burst
   *  began on the canvas (map zoom), this handler no-ops and lets the event
   *  bubble to `Camera`'s window listener, so a map zoom that drifts the
   *  cursor over a pin keeps zooming instead of being hijacked. Only when
   *  the gesture starts *on* a pin do we handle it here.
   *
   *  - Cmd/Ctrl + wheel: resize the card's intrinsic world size, anywhere on
   *    the card. Factor is proportional to `deltaY` so trackpad gestures
   *    feel continuous and mouse-wheel notches land the same ~10% step the
   *    previous chrome-only version did. Commit is debounced so one gesture
   *    fires one persisted write. See [[pin-resize-gesture-moves-target]]
   *    and constitution invariant 3.
   *  - Plain wheel: forwarded to the browser so overflow containers inside
   *    the card (vellum-shell, iframes) scroll natively. */
  private attachWheelResize(el: HTMLElement, entry: DomPinEntry): void {
    const RATE = 0.001
    let commitTimer: number | null = null
    el.addEventListener('wheel', (event) => {
      // Canvas owns an active zoom gesture — don't interfere. We deliberately
      // *don't* stopPropagation in this branch so the event reaches the
      // window-level camera handler.
      if (trackWheelEvent('card') !== 'card') return
      // This burst belongs to the card — keep the camera from also zooming.
      event.stopPropagation()
      if (!(event.ctrlKey || event.metaKey)) return
      if (!this.onPinResized) return
      event.preventDefault()
      const factor = Math.exp(event.deltaY * RATE)
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

  /** Wire a pointerdown on the pin element into a drag gesture that updates
   *  the pin's world position live and persists on release. Without a chrome
   *  strip to grab, drag is gated on Cmd/Ctrl — the same modifier that wheel-
   *  resize uses. Without the modifier, pointerdown inside the card falls
   *  through to whatever it's on (text selection in vellum, editor focus,
   *  link follow). The affordance cluster and resize handles are still
   *  excluded even when Cmd is held, since they are portolan-owned controls
   *  with their own gestures. Skipped if the host didn't provide
   *  `screenToWorld` / `onPinMoved`. Primary pointer only. */
  private attachPinDrag(el: HTMLElement, entry: DomPinEntry): void {
    if (!this.screenToWorld || !this.onPinMoved) return

    const DRAG_THRESHOLD_PX = 3

    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target as Element | null
      if (target?.closest('.dom-pin-affordances, .dom-pin-resize')) return

      // Prevent the browser from also starting a text selection under the
      // Cmd+drag gesture — without this, dragging a fiber card would smear
      // a text highlight across vellum's prose during the move.
      event.preventDefault()

      const startX = event.clientX
      const startY = event.clientY
      // Capture the offset from cursor world to pin anchor at drag start so
      // the card doesn't snap-recentre under the cursor on the first move.
      const startWorld = this.screenToWorld!(startX, startY)
      const offsetX = entry.pin.x - startWorld.x
      const offsetZ = entry.pin.z - startWorld.z
      let active = false

      const onMove = (ev: PointerEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return
          active = true
          entry.el.classList.add('dom-pin--dragging')
          document.body.style.cursor = 'grabbing'
          // Reuse the drag-to-pin suppression flag so MapInteractionController's
          // canvas-hover early-returns apply to pin drags too.
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

      // Don't preventDefault here — text selection inside vellum or a native
      // link click should still work. `isInteractiveTarget` has already
      // filtered those cases out of drag consideration.
    })
  }

  /** Pointerdown on an edge handle → drag to resize one dimension.
   *
   *  Cards use *two decoupled coordinate systems*: their world-space
   *  position (`pin.x`, `pin.z`) lives in the three.js camera's
   *  coordinates, but their size is stored in "card world units"
   *  (`entry.width`, `entry.height`) which render as CSS pixels scaled
   *  by `zoomRatio = REFERENCE_ZOOM / cameraDistance`. These scales
   *  disagree by a factor of roughly `canvas.width / (16*aspect)`.
   *
   *  Resize therefore needs TWO conversions:
   *  - Size delta: `dxScreen / zoomRatio` (card-size scale).
   *  - Center shift: half the cursor's *camera-world* delta from
   *    `Camera.screenToWorld` (same path chrome-drag uses).
   *
   *  The opposite edge stays pinned in screen space. See constitution
   *  invariant 4. */
  private attachResize(handle: HTMLElement, entry: DomPinEntry, kind: Handle): void {
    if (!this.onPinResized || !this.screenToWorld) return
    const { sx, sz } = handleSigns(kind)

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startY = event.clientY
      const startW = entry.width
      const startH = entry.height
      const startPinX = entry.pin.x
      const startPinZ = entry.pin.z
      const startCursor = this.screenToWorld!(startX, startY)
      let active = false

      const onMove = (ev: PointerEvent) => {
        const dxScreen = ev.clientX - startX
        const dyScreen = ev.clientY - startY
        if (!active) {
          if (Math.hypot(dxScreen, dyScreen) < 2) return
          active = true
          entry.el.classList.add('dom-pin--resizing')
          document.body.style.cursor = handleCursor(kind)
          // Reuse the same suppression flag as drag-to-pin / chrome-drag so
          // pin-hover and canvas interactions don't interfere mid-resize.
          document.body.classList.add('pin-dragging')
        }
        const ratio = this.zoomRatio()
        const cursor = this.screenToWorld!(ev.clientX, ev.clientY)

        // Size on each axis the handle affects; the other axis stays put.
        // Fraction captures how much of the intended delta survived clamping,
        // so hitting MIN/MAX freezes the center in lockstep with the edge.
        let nextW = startW
        let nextH = startH
        let pinX = startPinX
        let pinZ = startPinZ

        if (sx !== 0) {
          const intendedW = (sx * dxScreen) / ratio
          nextW = clampSize(startW + intendedW)
          const fracX = intendedW !== 0 ? (nextW - startW) / intendedW : 0
          pinX = startPinX + ((cursor.x - startCursor.x) * fracX) / 2
        }
        if (sz !== 0) {
          const intendedH = (sz * dyScreen) / ratio
          nextH = clampSize(startH + intendedH)
          const fracZ = intendedH !== 0 ? (nextH - startH) / intendedH : 0
          pinZ = startPinZ + ((cursor.z - startCursor.z) * fracZ) / 2
        }

        entry.width = nextW
        entry.height = nextH
        entry.pin = { ...entry.pin, x: pinX, z: pinZ }
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
        if (this.onPinMoved) {
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

function handleCursor(h: Handle): string {
  if (h === 'n' || h === 's') return 'ns-resize'
  if (h === 'e' || h === 'w') return 'ew-resize'
  if (h === 'ne' || h === 'sw') return 'nesw-resize'
  return 'nwse-resize' // nw, se
}

let pulseStylesInjected = false
function ensurePulseStyles(): void {
  if (pulseStylesInjected) return
  pulseStylesInjected = true
  // Cursor hint: when the user holds Cmd (or Ctrl on non-Mac), every pin
  // flips its cursor to `move` so the drag modifier is discoverable. The
  // modifier state is tracked via key events plus a `window.blur` / focus
  // fallback so it can never stick when attention leaves the page (e.g.
  // cmd-tab away mid-hold). CSS hook: `.dom-pin-cmd-held .dom-pin`.
  const setCmdHeld = (held: boolean) => {
    document.body.classList.toggle('dom-pin-cmd-held', held)
  }
  const onKey = (e: KeyboardEvent) => setCmdHeld(e.metaKey || e.ctrlKey)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  window.addEventListener('blur', () => setCmdHeld(false))
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
    /* Resize handles: four edge hit strips. Invisible hit zone straddles
       the card border so the cursor finds the handle both just inside and
       just outside the edge. Visual affordance is a thin parchment line
       that appears on hover along the edge being hovered. Constitution's
       "quiet by default + hover reveals affordances." */
    .dom-pin .dom-pin-resize::after {
      content: '';
      position: absolute;
      background: rgba(140, 110, 80, 0.7);
      opacity: 0;
      transition: opacity 120ms ease-out;
    }
    .dom-pin .dom-pin-resize--n::after,
    .dom-pin .dom-pin-resize--s::after {
      left: 0;
      right: 0;
      height: 2px;
      top: 50%;
      transform: translateY(-50%);
    }
    .dom-pin .dom-pin-resize--e::after,
    .dom-pin .dom-pin-resize--w::after {
      top: 0;
      bottom: 0;
      width: 2px;
      left: 50%;
      transform: translateX(-50%);
    }
    /* Corners: small parchment dot centered in the 14×14 hit zone. */
    .dom-pin .dom-pin-resize--ne::after,
    .dom-pin .dom-pin-resize--se::after,
    .dom-pin .dom-pin-resize--sw::after,
    .dom-pin .dom-pin-resize--nw::after {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }
    .dom-pin .dom-pin-resize:hover::after,
    .dom-pin--resizing .dom-pin-resize::after {
      opacity: 1;
    }
    /* Label mode — at narrow widths the pin collapses to just its label tab:
       a small parchment lozenge with the title. The inner reader body and
       the affordance cluster disappear; the tab is the single visible
       element. JS sets .dom-pin--label in position() when CSS width crosses
       LABEL_THRESHOLD. Resize handles stay live so the user can still grab
       and widen back into full-reader territory. */
    .dom-pin--label {
      box-shadow: none;
    }
    .dom-pin--label > *:not(.dom-pin-label-tab):not(.dom-pin-resize) {
      display: none !important;
    }
    .dom-pin--label .dom-pin-label-tab {
      display: block !important;
    }
    /* Affordance cluster: map-level × / ⋮ / ↗ in the top-right of the frame.
       Quiet at rest (opacity 0), revealed when the pin or its body is hovered
       or any button inside focuses. The pin wrapper owns the reveal — hovering
       any part of the card surfaces the affordances, not just the corner. */
    .dom-pin:hover .dom-pin-affordances,
    .dom-pin--hovered .dom-pin-affordances,
    .dom-pin-affordances:focus-within {
      opacity: 1;
    }
    .dom-pin-affordance-menu:hover,
    .dom-pin-affordance-menu:focus-visible,
    .dom-pin-affordance-ext:hover,
    .dom-pin-affordance-ext:focus-visible {
      background: rgba(46, 42, 38, 0.12) !important;
      outline: none;
    }
    /* Close (×): destructive-action red on hover, matching the context menu's
       Unpin styling so the user sees what the gesture does before committing. */
    .dom-pin-affordance-close:hover,
    .dom-pin-affordance-close:focus-visible {
      background: rgba(160, 48, 48, 0.12) !important;
      color: #A03030 !important;
      outline: none;
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
    /* Cmd/Ctrl held anywhere on the page → every pin advertises "drag me"
       via a grab cursor. Same modifier gates the drag gesture itself;
       without the key, click/drag falls through to text selection and
       other native content gestures. */
    body.dom-pin-cmd-held .dom-pin {
      cursor: grab;
    }
    .dom-pin--dragging {
      cursor: grabbing !important;
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
  // Pure visual frame: the outer pin wrapper already carries the
  // `region: "<kind> pin: <title>"` aria-label.
  //
  // role="presentation" alone isn't enough: React installs an `onclick = noop`
  // on every container it renders into (Mobile-Safari click-delegation
  // workaround in trapClickOnNonInteractiveElement; React 18 trips this for
  // the shell because it doesn't recognize __reactContainer$ as a root
  // marker). That click handler causes Chrome to expose the shell as
  // `generic [clickable]` and compute its accessible name from concatenated
  // descendant text ("◐ Annotations — pinsdecisionsclaim overlaysAnnotations
  // are the…"). A static aria-label short-circuits the text concat without
  // hiding descendants (aria-hidden would cascade).
  div.setAttribute('role', 'presentation')
  div.setAttribute('aria-label', 'Pin contents')
  Object.assign(div.style, {
    flex: '1 1 auto',
    minHeight: '0',
    overflow: 'auto',
    overscrollBehavior: 'contain',
    border: '1px solid rgba(140, 110, 80, 0.55)',
    borderRadius: '6px',
    background: 'rgba(248, 240, 225, 0.97)',
    boxShadow: '0 4px 16px rgba(46, 42, 38, 0.18)',
    color: '#2E2A26',
    fontFamily: '"EB Garamond", Garamond, serif',
  })
  return div
}

/** Host element for the wterm mount. Distinct from the vellum shell because
 *  wterm expects to own the grid layout + its own scroll region, and its
 *  palette was designed against a white-ish background (see
 *  constitution-terminals-in-map scope decisions: "Terminal background:
 *  white (#FAFAFA)"). Reuses the parchment border + shadow so the terminal
 *  still reads as a card on the map.
 *
 *  The shell itself must not clip — wterm adds `.has-scrollback` to its own
 *  element when scrollback is present, which toggles `overflow-y: auto` on
 *  the terminal root. A `overflow: hidden` here would suppress that scroll,
 *  which was the regression user-reported on 2026-04-19. Let wterm own the
 *  scroll region; the shell is just a frame. */
function renderTerminalShell(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'dom-pin-terminal-shell'
  // Pure visual frame; outer pin wrapper carries the aria-label.
  // See renderVellumShell for the same reasoning.
  div.setAttribute('role', 'presentation')
  Object.assign(div.style, {
    flex: '1 1 auto',
    minHeight: '0',
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid rgba(140, 110, 80, 0.55)',
    borderRadius: '6px',
    background: '#FAFAFA',
    boxShadow: '0 4px 16px rgba(46, 42, 38, 0.18)',
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
  if (s.sessionId) {
    // Terminal pin — host updates the chrome title later with the worker name
    // via `resolveFiberMeta`-style callback. Until then, show a compact
    // placeholder instead of the opaque `terminal-<sha>` slug.
    return `terminal · ${s.sessionId.slice(0, 8)}`
  }
  return pin.slug
}

/** Label tab: the parchment lozenge shown when the pin narrows past
 *  LABEL_THRESHOLD. In full-reader mode it's hidden by CSS; in label mode the
 *  inner body and affordances are hidden and this becomes the single visible
 *  element. Title-only — a distant map reads at a glance without trying to
 *  cram a full reader into a 100px-wide card. */
function renderLabelTab(displayTitle: string, slug: string): HTMLElement {
  const tab = document.createElement('div')
  tab.className = 'dom-pin-label-tab'
  const isSlug = displayTitle === slug
  Object.assign(tab.style, {
    display: 'none', // shown only when `.dom-pin--label` is set on the wrapper
    padding: '4px 10px',
    fontFamily: '"EB Garamond", Garamond, serif',
    fontSize: '12px',
    lineHeight: '1.2',
    color: '#2E2A26',
    background: 'rgba(248, 240, 225, 0.97)',
    border: '1px solid rgba(140, 110, 80, 0.55)',
    borderRadius: '6px',
    boxShadow: '0 2px 8px rgba(46, 42, 38, 0.14)',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'none',
    fontVariant: isSlug ? 'small-caps' : 'normal',
    letterSpacing: isSlug ? '0.03em' : '0',
  })
  tab.textContent = displayTitle
  return tab
}

function setLabelTabTitle(tab: HTMLElement, displayTitle: string, slug: string): void {
  tab.textContent = displayTitle
  const isSlug = displayTitle === slug
  tab.style.fontVariant = isSlug ? 'small-caps' : 'normal'
  tab.style.letterSpacing = isSlug ? '0.03em' : '0'
}

/** Top-right affordance cluster for map-level operations: × close, ⋮ menu, ↗
 *  external (URL pins only). Absolute-positioned over the top-right of the
 *  frame, quiet at rest, revealed on pin hover. These are *map* gestures —
 *  closing a pin and the map context menu — and have no business inside
 *  vellum's own chrome. Buttons stop propagation so the frame-drag handler
 *  doesn't treat a click on × as a grab. */
function renderAffordances(pin: Pin): HTMLElement {
  const cluster = document.createElement('div')
  cluster.className = 'dom-pin-affordances'
  Object.assign(cluster.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    zIndex: '4',
    pointerEvents: 'auto',
    opacity: '0',
    transition: 'opacity 120ms ease-out',
  })

  const mkBtn = (
    className: string,
    glyph: string,
    label: string,
  ): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = className
    btn.textContent = glyph
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.tabIndex = -1
    Object.assign(btn.style, {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: '#2E2A26',
      cursor: 'pointer',
      fontFamily: '"EB Garamond", Garamond, serif',
      fontSize: '15px',
      lineHeight: '1',
      padding: '2px 5px',
      borderRadius: '4px',
      transition: 'background-color 120ms ease-out, color 120ms ease-out',
    })
    btn.addEventListener('pointerdown', (e) => { e.stopPropagation() })
    return btn
  }

  if (pin.source?.url) {
    const ext = document.createElement('a')
    ext.className = 'dom-pin-affordance-ext'
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
      color: '#2E2A26',
      fontFamily: '"EB Garamond", Garamond, serif',
      fontSize: '15px',
      lineHeight: '1',
      padding: '2px 5px',
      textDecoration: 'none',
      borderRadius: '4px',
      transition: 'background-color 120ms ease-out',
    })
    ext.addEventListener('pointerdown', (e) => { e.stopPropagation() })
    ext.addEventListener('click', (e) => { e.stopPropagation() })
    cluster.appendChild(ext)
  }

  // Qualify the affordance buttons with the pin's title so a screen-reader
  // (or agent-browser snapshot) sees N distinct "Pin menu for X" / "Unpin X"
  // buttons rather than N copies of generic "Pin menu" / "Unpin". Mirrors
  // the disambiguation pattern from worker-palette/recent-worker labels —
  // see commit 1f69078 (qualify worker palette options with their city).
  const pinTitle = titleForPin(pin)
  cluster.appendChild(mkBtn('dom-pin-affordance-menu', '⋮', `Pin menu for ${pinTitle}`))
  cluster.appendChild(mkBtn('dom-pin-affordance-close', '×', `Unpin ${pinTitle}`))

  return cluster
}

/** Targets that should not initiate a pin drag or primary-open gesture:
 *  vellum's editor surfaces, form fields, buttons, anchors, the affordance
 *  cluster, and the resize handles. Everything else is fair game for
 *  grabbing the card. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [contenteditable], [contenteditable="true"], ' +
      '.cm-editor, .cm-content, .cm-scroller, ' +
      '.dom-pin-affordances, .dom-pin-resize',
    ),
  )
}

function sourceKey(pin: Pin): string {
  const s = pin.source
  if (!s) return ''
  if (s.url) return `url:${s.url}`
  if (s.sessionId) return `session:${s.sessionId}`
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
      borderRadius: '6px',
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
      borderRadius: '6px',
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
  // Without a chrome strip, the link card's body carries the title itself as
  // a small Garamond header above the action line. Typographic, not tinted.
  const title = document.createElement('div')
  title.textContent = titleForPin(pin)
  Object.assign(title.style, {
    fontFamily: '"EB Garamond", Garamond, serif',
    fontSize: '13px',
    color: '#2E2A26',
    marginBottom: '4px',
    fontVariant: titleForPin(pin) === pin.slug ? 'small-caps' : 'normal',
    letterSpacing: titleForPin(pin) === pin.slug ? '0.03em' : '0',
  })
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
  a.appendChild(title)
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
    borderRadius: '6px',
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
    borderRadius: '4px',
  })
  return div
}

function renderResizeHandle(kind: Handle): HTMLElement {
  const h = document.createElement('div')
  h.className = `dom-pin-resize dom-pin-resize--${kind}`
  h.title = 'Drag to resize'
  // Edges: invisible hit strip straddling the border so the cursor finds
  // it both just inside and just outside the card. Corners: 14×14 hit
  // square at the corner, stacked above the edges via z-index so the
  // diagonal cursor wins where they overlap. Visual affordance is a thin
  // parchment line / dot shown on hover — "quiet by default."
  const style: Partial<CSSStyleDeclaration> = {
    position: 'absolute',
    cursor: handleCursor(kind),
    touchAction: 'none',
  }
  const EDGE_THICK = '10px'
  const EDGE_OFFSET = '-5px'
  const CORNER_SIZE = '14px'
  const CORNER_OFFSET = '-7px'
  if (kind.length === 1) {
    // Edge
    style.zIndex = '2'
    if (kind === 'n' || kind === 's') {
      style.left = '0'
      style.right = '0'
      style.height = EDGE_THICK
      style[kind === 'n' ? 'top' : 'bottom'] = EDGE_OFFSET
    } else {
      style.top = '0'
      style.bottom = '0'
      style.width = EDGE_THICK
      style[kind === 'w' ? 'left' : 'right'] = EDGE_OFFSET
    }
  } else {
    // Corner — sits above edges
    style.zIndex = '3'
    style.width = CORNER_SIZE
    style.height = CORNER_SIZE
    style[kind.includes('n') ? 'top' : 'bottom'] = CORNER_OFFSET
    style[kind.includes('w') ? 'left' : 'right'] = CORNER_OFFSET
  }
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
