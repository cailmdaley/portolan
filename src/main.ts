// main.ts - Bootstrap and render loop

import {
  Scene,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Color,
} from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { HexGrid } from './render/HexGrid'
import { ZoneRenderer } from './render/ZoneRenderer'
import { Camera } from './render/Camera'
import { DomPinLayer } from './render/DomPinLayer'
import { TerminalPinManager } from './terminal/TerminalPinManager'
import '@wterm/dom/css'

// Hoisted: lazy import the vellum mount module so DomPinLayer (built below)
// can close over it for inline markdown + fiber rendering.
const vellumMountPromise = import('./vellum/mount')
import { listPins, putPin, pinFile, deletePin, type Pin, type PinKind, type PinSource } from './state/layoutClient'
import { PinDragController } from './PinDragController'
import { FileDropController } from './FileDropController'
import { MapInteractionController } from './MapInteractionController'
import { FrontendMapActions } from './FrontendMapActions'
import { installFrontendRuntimeDiagnostics } from './runtime/FrontendRuntimeDiagnostics'
import { getActivitySessionKey } from './runtime/FrontendActivityStore'
import { FrontendStateSync } from './runtime/FrontendStateSync'
import { FrontendAppRuntime } from './runtime/FrontendAppRuntime'
import { CityHUD } from './ui/CityHUD'
import { ContextMenu } from './ui/ContextMenu'
import { PlaygroundViewer } from './ui/PlaygroundViewer'
import { NewWorkerDialog } from './ui/NewWorkerDialog'
import { GlobalSearchPalette } from './ui/GlobalSearchPalette'
import { RecentWorkerBar } from './ui/RecentWorkerBar'
import { clearArtifactMediaCaches, getArtifactMediaCacheStats } from './ui/ArtifactMedia'
import type { City, Session, ServerOrigin } from './state/types'
import { findBestMatchingCity, findNearestCity } from './state/cityLookup'
import { PALETTE } from './state/types'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const canvasOverlay = canvas

// Setup renderer
const renderer = new WebGLRenderer({
  canvas,
  antialias: true,
})
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(new Color(PALETTE.bgPrimary))
renderer.shadowMap.enabled = true

// CSS2D renderer for HTML labels (small caps, petite caps)
const labelRenderer = new CSS2DRenderer()
labelRenderer.setSize(window.innerWidth, window.innerHeight)
labelRenderer.domElement.style.position = 'absolute'
labelRenderer.domElement.style.top = '0'
labelRenderer.domElement.style.left = '0'
labelRenderer.domElement.style.pointerEvents = 'none'
labelRenderer.domElement.style.userSelect = 'none'
// CSS2DRenderer assigns each label a per-frame z-index from its camera depth
// (range roughly 0..100000). Confine that range with `isolation: isolate` so
// CSS2D labels can never punch up through the DOM pin layer (z-index 20) or
// HUD panels. Without this, labels from neighbouring cities would render on
// top of open pin cards. [[floating-card-feel]]
labelRenderer.domElement.style.zIndex = '10'
labelRenderer.domElement.style.isolation = 'isolate'
labelRenderer.domElement.classList.add('label-container')
document.body.appendChild(labelRenderer.domElement)

// Setup scene
const scene = new Scene()

// Lighting - warm desert sun
const ambientLight = new AmbientLight(0xffeedd, 0.6)
scene.add(ambientLight)

const directionalLight = new DirectionalLight(0xfff5e1, 0.8)
directionalLight.position.set(10, 20, 5)
directionalLight.castShadow = true
directionalLight.shadow.mapSize.width = 2048
directionalLight.shadow.mapSize.height = 2048
directionalLight.shadow.camera.near = 1
directionalLight.shadow.camera.far = 50
directionalLight.shadow.camera.left = -20
directionalLight.shadow.camera.right = 20
directionalLight.shadow.camera.top = 20
directionalLight.shadow.camera.bottom = -20
scene.add(directionalLight)

// Setup hex grid (size 50 = radius of 50 hexes, hexRadius 1.0)
// hexRadius = 1/sqrt(3) makes adjacent hex centers exactly 1 world unit apart
const hexGrid = new HexGrid(100, 1 / Math.sqrt(3))

// Setup camera (use overlay for events - Safari compatibility)
const camera = new Camera(canvas, canvasOverlay)

// Setup zone renderer
const zoneRenderer = new ZoneRenderer(scene, hexGrid)

let pinnedCityId: string | null = null
let movingPinSlug: string | null = null

// Read-only terminal pins — ephemeral, client-only pins that render a live
// wterm view of a worker's tmux pane. See [[constitution-terminals-in-map]]
// and [[terminal-pin-topology]]. Keyed by cityId because pins are loaded per
// city; when the user switches cities we rebuild the pin set and the
// ephemeral pins for that city are merged alongside the persisted set.
const ephemeralTerminalPins = new Map<string, Map<string, Pin>>()
const terminalPinManager = new TerminalPinManager()

function getEphemeralTerminalPins(cityId: string): Pin[] {
  const bucket = ephemeralTerminalPins.get(cityId)
  return bucket ? [...bucket.values()] : []
}

function setEphemeralTerminalPin(cityId: string, pin: Pin): void {
  let bucket = ephemeralTerminalPins.get(cityId)
  if (!bucket) {
    bucket = new Map()
    ephemeralTerminalPins.set(cityId, bucket)
  }
  bucket.set(pin.slug, pin)
}

function removeEphemeralTerminalPin(cityId: string, slug: string): boolean {
  const bucket = ephemeralTerminalPins.get(cityId)
  if (!bucket) return false
  const existed = bucket.delete(slug)
  if (bucket.size === 0) ephemeralTerminalPins.delete(cityId)
  return existed
}

// DOM-overlay surface for all pin kinds — fiber, text, pdf, image, html,
// other. Each pin is a real DOM node anchored to world space, reanchored per
// frame via `camera.worldToScreen`. Fibers mount vellum's FiberCard; text pins
// mount vellum's FileViewerPage (the same surface the modal uses — see
// [[card-modal-parity]]); the rest fall back to iframe/img/link.
// See tapestry-dissolves and [[file-view-as-floating-card]].
const domPinLayer = new DomPinLayer({
  camera,
  resolveSource: (pin) => {
    const src = pin.source
    if (!src) return null
    if (src.url) return src.url
    if (!src.path || !src.originId) return null
    return `http://${window.location.hostname}:4004/project-file/${encodeURIComponent(src.originId)}${src.path}`
  },
  onContextMenu: (slug, clientX, clientY) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    const pin = domPinLayer.getPin(slug)
    const items = []
    if (pin?.kind === 'fiber') {
      items.push({
        label: 'Open Fiber',
        action: () => openCityWorkspace(city, slug),
      })
    } else if (pin?.kind === 'terminal' && pin.source?.sessionId) {
      items.push({
        label: 'Focus Worker',
        action: () => mapActions?.focusKittyTab(pin.source!.sessionId!),
      })
    } else if (pin?.source?.path) {
      // Non-fiber file pin — open the file in vellum's full modal viewer.
      // The inline pin is a peek; the modal is the full reading surface.
      items.push({
        label: 'Open File',
        action: () => openFile({
          path: pin.source!.path!,
          originId: pin.source!.originId,
          cityId: city.id,
        }),
      })
    } else if (pin?.source?.url) {
      items.push({
        label: 'Open in Browser',
        action: () => window.open(pin.source!.url!, '_blank', 'noopener,noreferrer'),
      })
    }
    items.push(
      {
        label: 'Move Pin',
        action: () => {
          // Move-on-next-canvas-click flow lives in MapInteractionController;
          // cursor reverts on commit/escape via setMovingPinSlug.
          movingPinSlug = slug
          document.body.style.cursor = 'crosshair'
        },
      },
      {
        label: 'Unpin Card',
        action: () => {
          domPinLayer.remove(slug)
          syncPinnedSlugs()
          if (pin?.kind === 'terminal') {
            removeEphemeralTerminalPin(city.id, slug)
            return
          }
          void deletePin(city.id, slug).catch(err => console.error('[pins] unpin failed', err))
        },
        danger: true,
      },
    )
    contextMenu.show(clientX, clientY, items)
  },
  // Double-click on chrome → same "Open" action as the context menu offers, so
  // opening a pin isn't hidden behind right-click. Fiber → workspace; path →
  // vellum file modal; url → new tab.
  onPrimaryOpen: (slug) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    const pin = domPinLayer.getPin(slug)
    if (!pin) return
    if (pin.kind === 'fiber') {
      openCityWorkspace(city, slug)
    } else if (pin.source?.path) {
      openFile({
        path: pin.source.path,
        originId: pin.source.originId,
        cityId: city.id,
      })
    } else if (pin.source?.url) {
      window.open(pin.source.url, '_blank', 'noopener,noreferrer')
    }
  },
  cityIdFor: () => cityPanel.getCurrentCity()?.id ?? pinnedCityId ?? undefined,
  screenToWorld: (x, y) => camera.screenToWorld(x, y),
  // Chrome-strip drag: pointer-down on the title bar of a DOM pin repositions
  // the card live; release commits via putPin. Foundational move toward the
  // floating-card primitive. See [[file-view-as-floating-card]].
  onPinMoved: (slug, x, z) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    const live = domPinLayer.getPin(slug)
    if (live?.kind === 'terminal') {
      // Ephemeral pins persist client-side only; layer already updated its
      // own copy during drag, so just mirror into the ephemeral store.
      setEphemeralTerminalPin(city.id, { ...live, x, z })
      return
    }
    void putPin(city.id, slug, { x, z })
      .then(pin => { if (pinnedCityId === city.id) domPinLayer.upsert(pin) })
      .catch(err => console.error('[pins] drag-move failed', err))
  },
  // Resize-handle drag: persist the new CSS-pixel intrinsic size via putPin,
  // which preserves x/z/kind/source server-side. Foundational for the
  // floating-card primitive — see [[file-view-as-floating-card]].
  onPinResized: (slug, width, height) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    // Read current position from the live pin — chrome-strip drags update it
    // locally between server commits, so using the in-memory copy avoids a
    // stale-coord round-trip if a resize follows a move before the PUT settles.
    const live = domPinLayer.getPin(slug)
    if (!live) return
    if (live.kind === 'terminal') {
      setEphemeralTerminalPin(city.id, { ...live, width, height })
      return
    }
    void putPin(city.id, slug, { x: live.x, z: live.z }, { width, height })
      .then(pin => { if (pinnedCityId === city.id) domPinLayer.upsert(pin) })
      .catch(err => console.error('[pins] resize failed', err))
  },
  // Chrome-strip metadata resolver. For fiber pins, look up the fiber's
  // frontmatter `name` (so the chrome shows "Pin any file type on the map"
  // instead of the raw slug) and `status` (so the chrome paints an open/
  // active/closed glyph — restoring the at-a-glance signal that retired with
  // the canvas-pin status painter). Non-fiber pins return null and keep the
  // source-derived default title with no glyph.
  resolveFiberMeta: async (pin) => {
    if (pin.kind !== 'fiber') return null
    const cityId = cityPanel.getCurrentCity()?.id ?? pinnedCityId
    const url = cityId
      ? `http://${window.location.hostname}:4004/fiber/${encodeURIComponent(pin.slug)}?cityId=${encodeURIComponent(cityId)}`
      : `http://${window.location.hostname}:4004/fiber/${encodeURIComponent(pin.slug)}`
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const body = await res.json()
      const name = body?.frontmatter?.name
      const rawStatus = body?.frontmatter?.status
      const status = rawStatus === 'active' || rawStatus === 'closed' ? rawStatus : 'open'
      return {
        name: typeof name === 'string' && name.trim() ? name : null,
        status,
      }
    } catch {
      return null
    }
  },
  // Map→HUD hover bridge: light up the matching `.hud-fiber-item` when the
  // cursor enters a pin. DOM pins swallow pointer events above the canvas,
  // so without this the HUD row never hears about the hover. See
  // tapestry-dissolves: "map-hover-highlights-hud."
  onHover: (slug) => {
    cityPanel.setMapHoveredFiber(slug)
  },
  // Lazy: vellum module is async-imported. Until it resolves, text pins fall
  // back to the link-card stub. See [[card-modal-parity]] for the
  // card ↔ modal parity contract.
  mountVellumSurface: (container, opts) => {
    let unmounted = false
    let handle: { unmount(): void } | null = null
    void vellumMountPromise.then(({ mountVellumFileSurface }) => {
      if (unmounted) return
      handle = mountVellumFileSurface(container, opts)
    })
    return {
      unmount() {
        unmounted = true
        handle?.unmount()
      },
    }
  },
  // Terminal pins mount wterm inline. TerminalPinManager owns the WebSocket
  // routing + wterm lifecycle; the pin layer just hands over the container.
  // See [[constitution-terminals-in-map]].
  mountTerminalSurface: (container, opts) => {
    return terminalPinManager.mount({ sessionId: opts.sessionId, container })
  },
  // Fiber pins mount vellum's FiberCard inline — the same primitive the reader
  // uses, rendered in the pin's DOM surface. See tapestry-dissolves Next.
  mountVellumFiberSurface: (container, opts) => {
    let unmounted = false
    let handle: { unmount(): void; update(next: typeof opts): void } | null = null
    let latest = opts
    void vellumMountPromise.then(({ mountVellumFiberSurface }) => {
      if (unmounted) return
      handle = mountVellumFiberSurface(container, latest)
    })
    return {
      unmount() {
        unmounted = true
        handle?.unmount()
      },
      resize(width: number) {
        latest = { ...latest, width }
        handle?.update(latest)
      },
    }
  },
})

async function loadPinsForCity(cityId: string): Promise<void> {
  try {
    const pins = await listPins(cityId)
    if (pinnedCityId !== cityId) return // city changed mid-flight
    const unstacked = await unstackColocatedPins(cityId, pins)
    if (pinnedCityId !== cityId) return
    // Ephemeral terminal pins are client-side only (not round-tripped through
    // the layout store) so merge them after the persisted set arrives. See
    // `ephemeralTerminalPins`.
    const merged = [...unstacked, ...getEphemeralTerminalPins(cityId)]
    domPinLayer.setPins(merged)
    syncPinnedSlugs()
  } catch (err) {
    console.error('[pins] load failed for', cityId, err)
  }
}

/** Fan out pins that persist at identical (x,z) coords. Keeps the first pin in
 *  each colocated group at its anchor; displaces the rest onto a ring sized to
 *  the pin's card width so neighbors sit edge-to-edge rather than overlapping.
 *  Persists the new position so the unstack is sticky. Legacy layouts from
 *  before the click-spawn fan-out could park multiple pins at a city's hex;
 *  this heals them on first load without forcing the user to drag each one.
 *  See fiber-pins-overlap-at-same-coords. We match on exact coords rather
 *  than proximity because manually-placed pins naturally sit within a card
 *  width of each other and must not be re-separated. */
async function unstackColocatedPins(
  cityId: string,
  pins: Pin[],
): Promise<Pin[]> {
  const groups = new Map<string, Pin[]>()
  for (const pin of pins) {
    const key = `${pin.x.toFixed(3)}:${pin.z.toFixed(3)}`
    const group = groups.get(key)
    if (group) group.push(pin)
    else groups.set(key, [pin])
  }
  const result = [...pins]
  const byslug = new Map(result.map((p, i) => [p.slug, i]))
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (let i = 1; i < group.length; i++) {
      const pin = group[i]
      const angle = ((i - 1) / 6) * Math.PI * 2
      const radius = fanOutRadius(pin) * (Math.floor((i - 1) / 6) + 1)
      const x = pin.x + Math.cos(angle) * radius
      const z = pin.z + Math.sin(angle) * radius
      try {
        const moved = await putPin(cityId, pin.slug, { x, z }, {
          kind: pin.kind,
          source: pin.source,
          width: pin.width,
          height: pin.height,
        })
        const idx = byslug.get(pin.slug)
        if (idx !== undefined) result[idx] = moved
      } catch (err) {
        console.error('[pins] unstack failed for', pin.slug, err)
      }
    }
  }
  return result
}

/** Translate every pin owned by `cityId` by the world-space delta. Used when a
 *  city is moved — the pins follow along. Serial PUTs keep the persisted state
 *  coherent even if one write fails; upsert as each commits so the on-screen
 *  cards slide together rather than jumping at the end. */
async function translatePinsBy(cityId: string, dx: number, dz: number): Promise<void> {
  try {
    const pins = await listPins(cityId)
    for (const pin of pins) {
      try {
        const moved = await putPin(
          cityId,
          pin.slug,
          { x: pin.x + dx, z: pin.z + dz },
          {
            kind: pin.kind,
            source: pin.source,
            width: pin.width,
            height: pin.height,
          },
        )
        if (pinnedCityId === cityId) domPinLayer.upsert(moved)
      } catch (err) {
        console.error('[pins] translate failed for', pin.slug, err)
      }
    }
    if (pinnedCityId === cityId) syncPinnedSlugs()
  } catch (err) {
    console.error('[pins] translate listPins failed for', cityId, err)
  }
}

/** Push the current set of pinned slugs to the HUD so fiber items can badge
 *  themselves as already pinned on the map. Call after any pin mutation. */
function syncPinnedSlugs(): void {
  cityPanel.setPinnedSlugs(new Set(domPinLayer.getSlugs()))
}

/** Pan camera to a pin's anchor and pulse it. Used as "already pinned — here
 *  it is" feedback for the click-spawns-card gesture. */
function panAndPulse(slug: string): void {
  const pin = domPinLayer.getPin(slug)
  if (pin) camera.focusOn({ x: pin.x, z: pin.z })
  domPinLayer.pulse(slug)
}

/** Fan-out ring radius in world units, scaled to the pin's card width so
 *  adjacent ring slots sit edge-to-edge instead of overlapping. Ring chord
 *  equals radius for 6 slots (2R·sin(30°) = R), so we size the radius to the
 *  card's world-unit width plus a small gap. Card width in world units ≈
 *  CSS-width / pxPerUnit-at-reference-zoom; camera math puts pxPerUnit ≈ 50
 *  at REFERENCE_ZOOM, but we avoid coupling to camera state by using a fixed
 *  divisor tuned to match the rendered scale. */
const FAN_OUT_PX_PER_UNIT = 50
const FAN_OUT_GAP_UNITS = 0.5
const FAN_OUT_MIN_RADIUS = 2.2

function fanOutRadius(pin: { kind?: PinKind; width?: number }): number {
  const kind = (pin.kind ?? 'other') as PinKind
  const defaultWidth = DEFAULT_PIN_WIDTH[kind] ?? DEFAULT_PIN_WIDTH.other
  const widthPx = pin.width ?? defaultWidth
  const widthUnits = widthPx / FAN_OUT_PX_PER_UNIT
  return Math.max(FAN_OUT_MIN_RADIUS, widthUnits + FAN_OUT_GAP_UNITS)
}

/** Kind-default widths mirroring DomPinLayer.DEFAULT_SIZE — duplicated here
 *  to keep fan-out geometry independent of the render layer's internals. */
const DEFAULT_PIN_WIDTH: Record<PinKind, number> = {
  fiber: 320,
  text: 420,
  pdf: 320,
  html: 420,
  image: 320,
  other: 260,
  terminal: 640,
}

/** Compute a fan-out spawn position at a city. Fiber and file pins land at the
 *  city's hex; subsequent pins get a ring offset sized to the new pin's card
 *  so cards sit beside each other rather than overlapping. Offsets are based
 *  on the current pin count in the city's layer. */
function spawnPositionForCity(
  city: City,
  pin: { kind?: PinKind; width?: number } = {},
): { x: number; z: number } {
  const base = hexGrid.axialToCartesian(city.hex)
  const count = domPinLayer.getSlugs().length
  if (count === 0) return { x: base.x, z: base.z }
  const ring = Math.floor((count - 1) / 6) + 1
  const indexInRing = (count - 1) % 6
  const angle = (indexInRing / 6) * Math.PI * 2
  const radius = fanOutRadius(pin) * ring
  return {
    x: base.x + Math.cos(angle) * radius,
    z: base.z + Math.sin(angle) * radius,
  }
}

/** Spawn or pulse a pin at the city's hex in response to an onOpenFile event.
 *  Fiber paths (`.felt/<slug>/<slug>.md`) pin under the fiber slug. All other
 *  paths go through pinFile so the server derives a stable content-addressed
 *  slug (idempotent re-pin). See tapestry-dissolves Next: click-spawns-card. */
async function spawnOrPulseCardAtCity(
  city: City,
  fullPath: string,
  originId: string,
): Promise<void> {
  const fiberMatch = /\/\.felt\/([^/]+)\/\1\.md$/.exec(fullPath)
  const kind = fiberMatch ? ('fiber' as PinKind) : inferPinKindFromPath(fullPath)
  const pos = spawnPositionForCity(city, { kind })
  try {
    if (fiberMatch) {
      const slug = fiberMatch[1]
      if (domPinLayer.has(slug)) {
        panAndPulse(slug)
        return
      }
      const pin = await putPin(city.id, slug, pos, { kind: 'fiber' })
      if (pinnedCityId === city.id) {
        domPinLayer.upsert(pin)
        syncPinnedSlugs()
        window.setTimeout(() => panAndPulse(pin.slug), 0)
      }
      return
    }
    const source: PinSource = { originId, path: fullPath }
    const pin = await pinFile(city.id, pos, source, kind)
    // pinFile is idempotent server-side — if the slug came back already
    // present, treat the spawn as a "find it" gesture.
    const alreadyHere = domPinLayer.has(pin.slug)
    if (pinnedCityId === city.id) {
      domPinLayer.upsert(pin)
      syncPinnedSlugs()
    }
    if (alreadyHere) {
      panAndPulse(pin.slug)
    } else {
      window.setTimeout(() => panAndPulse(pin.slug), 0)
    }
  } catch (err) {
    console.error('[pins] click-spawn failed', err)
  }
}

// Kept in sync with server/src/LayoutStore.ts `kindFromPath`. Client-side copy
// because drop/paste needs to infer the kind before the pin hits the server.
// The server is authoritative on accepted kinds — this mirror just primes the
// request. See [[card-modal-parity]].
function inferPinKindFromPath(path: string): PinKind | undefined {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'pdf': return 'pdf'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': case 'avif': case 'bmp':
      return 'image'
    case 'html': case 'htm': return 'html'
    case 'md': case 'markdown': case 'mdx':
    case 'tex':
    case 'py': case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'txt':
    case 'json': case 'yaml': case 'yml': case 'toml':
    case 'sh': case 'bash': case 'zsh':
    case 'smk':
    case 'css': case 'scss':
      return 'text'
    default: return undefined
  }
}

// Wire up worker label click handlers (CSS2D labels need direct handlers)
zoneRenderer.setWorkerClickHandler((workerId, _tmuxSession) => {
  mapActions?.focusKittyTab(workerId)
})

zoneRenderer.setWorkerDblClickHandler((workerId, _tmuxSession) => {
  mapActions?.focusKittyTab(workerId)
})

// Right-click on a worker → offer "Pin terminal". See
// [[constitution-terminals-in-map]] and [[terminal-pin-topology]]. The pin
// is ephemeral (client-only) and placed at the worker's current world
// position so it lands right next to the bird; user can drag from there.
zoneRenderer.setWorkerContextMenuHandler((workerId, _tmuxSession, clientX, clientY) => {
  const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
  if (!city) return
  const session = sessions.find(s => s.id === workerId)
  if (!session) return
  const swarmPos = zoneRenderer.getSwarmWorldPosition(workerId)
  const origin = camera.screenToWorld(clientX, clientY)
  const slug = `terminal-${workerId}`
  const alreadyPinned = domPinLayer.has(slug)
  const items: Array<{ label: string; action: () => void; danger?: boolean }> = []
  if (alreadyPinned) {
    items.push({
      label: 'Focus Terminal Pin',
      action: () => {
        const pin = domPinLayer.getPin(slug)
        if (pin) camera.focusOn({ x: pin.x, z: pin.z })
        domPinLayer.pulse(slug)
      },
    })
    items.push({
      label: 'Unpin Terminal',
      action: () => {
        domPinLayer.remove(slug)
        removeEphemeralTerminalPin(city.id, slug)
        syncPinnedSlugs()
      },
      danger: true,
    })
  } else {
    items.push({
      label: 'Pin Terminal',
      action: () => {
        const anchor = swarmPos ?? { x: origin.x, z: origin.z }
        const pin: Pin = {
          slug,
          x: anchor.x,
          z: anchor.z,
          pinnedAt: Date.now(),
          kind: 'terminal',
          source: { sessionId: session.id },
        }
        setEphemeralTerminalPin(city.id, pin)
        domPinLayer.upsert(pin)
        syncPinnedSlugs()
      },
    })
  }
  items.push({
    label: 'Focus Worker',
    action: () => mapActions?.focusKittyTab(workerId),
  })
  contextMenu.show(clientX, clientY, items)
})

// Wire up worker label hover → file tooltip (same as bird hover but triggered from CSS2D label)
zoneRenderer.setWorkerLabelHoverHandlers(
  (workerId, _tmuxSession, anchor) => {
    const session = sessions.find(s => s.id === workerId)
    if (session) {
      zoneRenderer.updateWorkerFileHover(session, anchor)
    }
  },
  () => {
    zoneRenderer.clearWorkerFileHover()
  }
)

// Wire up city label click handler (needed for remote cities without sprites)
// Uses handleCityClick defined below (after cityPanel initialization)
zoneRenderer.setCityLabelClickHandler((cityId) => {
  const city = cities.find(c => c.id === cityId)
  if (city) handleCityClick(city)
})

// Provide camera's screen-to-world conversion for accurate drag
zoneRenderer.setScreenToWorldConverter((x, y) => camera.screenToWorld(x, y))

// Setup city HUD (corner-anchored widgets, replaces CityPanel)
const cityPanel = new CityHUD()

// Shared handler for city clicks (used by sprite click and label click)
function handleCityClick(city: City): void {
  selectedHex = city.hex

  // Focus on city and zoom to detail level
  const pos = hexGrid.axialToCartesian(city.hex)
  camera.focusAndZoom(pos, 6, 0.95)

  if (city.isDormant && city.originId !== 'local') {
    void mapActions?.activateRemoteCity(city)
  } else {
    cityPanel.show(city)
    cityPanel.updateWorkers(sessions)
  }

  if (pinnedCityId !== city.id) {
    pinnedCityId = city.id
    domPinLayer.clear()
    syncPinnedSlugs()
    void loadPinsForCity(city.id)
  }
}

// Vellum is the file viewer. React modal mounted via openVellumFileModal.
// See vellum-in-portolan: portolan's FileViewerModal has been retired from the
// user-facing path; all file opens go through vellum + PortolanAdapter.
// (Note: vellumMountPromise itself is hoisted above DomPinLayer construction
// so the inline-vellum mount factory can close over it.)

interface OpenFileArgs {
  path: string
  originId?: string
  cityId?: string
  jumpToLine?: number
  editable?: boolean
}

function openFile(args: OpenFileArgs): void {
  void vellumMountPromise.then(({ openVellumFileModal }) => {
    openVellumFileModal({
      path: args.path,
      originId: args.originId,
      cityId: args.cityId,
      jumpToLine: args.jumpToLine,
      editable: args.editable ?? true,
    })
  })
}

// Vellum workspace modal for a city — narrative / workspace / delta / map modes
// against the PortolanAdapter. Replaces TapestryView on `t` / deep-press; see
// tapestry-dissolves. Single-instance: close the previous handle before opening
// a new city.
let activeWorkspaceHandle: { close(): void } | null = null
function openCityWorkspace(city: City, initialSlug?: string): void {
  activeWorkspaceHandle?.close()
  activeWorkspaceHandle = null
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    const handle = openVellumWorkspaceModal({
      cityId: city.id,
      originId: city.originId,
      initialSlug,
    })
    activeWorkspaceHandle = handle
  })
}

// URL-param auto-open retained for deep-linking and debugging.
const initialParams = new URLSearchParams(window.location.search)
const debugPath = initialParams.get('vellumDebug')
if (debugPath) {
  const lineParam = initialParams.get('vellumLine')
  const jumpToLine = lineParam ? Number(lineParam) : undefined
  openFile({
    path: debugPath,
    originId: initialParams.get('vellumOrigin') ?? undefined,
    cityId: initialParams.get('vellumCity') ?? undefined,
    editable: initialParams.get('vellumEdit') !== '0',
    jumpToLine: Number.isFinite(jumpToLine) ? jumpToLine : undefined,
  })
}

// Wire up file click from worker hover tooltip to vellum.
zoneRenderer.setWorkerFileClickHandler((fullPath, originId, _workerId) => {
  const city = findBestMatchingCity(cities, originId, fullPath)
  openFile({ path: fullPath, originId, cityId: city?.id })
})

// Click-spawns-card: HUD fiber clicks and file-search clicks place a floating
// card at the city's hex instead of opening a modal. If the thing is already
// pinned, pan camera and pulse it instead of duplicating. See tapestry-dissolves.
cityPanel.setOnOpenFile((fullPath, originId, _cityPath, cityId, _line) => {
  const city = cities.find(c => c.id === cityId)
  if (!city) return
  void spawnOrPulseCardAtCity(city, fullPath, originId)
})

// Setup context menu
const contextMenu = new ContextMenu()

// Setup new worker dialog
const newWorkerDialog = new NewWorkerDialog()

// Wire up new worker dialog to city panel
cityPanel.setNewWorkerDialog(newWorkerDialog)

// Wire up worker click from city HUD
cityPanel.setOnFocusWorker((sessionId) => {
  mapActions?.focusKittyTab(sessionId)
})

// HUD→map hover bridge: hovering a pinned fiber in the HUD lifts its card on
// the map. See tapestry-dissolves.
cityPanel.setOnPinnedFiberHover((slug) => {
  domPinLayer.setHovered(slug)
})

cityPanel.setOnViewClaims((city) => {
  cityPanel.hide()
  openCityWorkspace(city)
})

// Setup playground viewer
const playgroundViewer = new PlaygroundViewer()

const globalSearchPalette = new GlobalSearchPalette({
  onSelectCity: (city) => {
    handleCityClick(city)
  },
  onSelectWorker: (session) => {
    const swarmPos = zoneRenderer.getSwarmWorldPosition(session.id)
    if (swarmPos) {
      camera.focusAndZoom(swarmPos, 6, 0.95)
    } else if (session.hex) {
      camera.focusAndZoom(hexGrid.axialToCartesian(session.hex), 6, 0.95)
    }
    mapActions?.focusKittyTab(session.id)
  },
})

const recentWorkerBar = new RecentWorkerBar({
  onSelectWorker: (session) => {
    const swarmPos = zoneRenderer.getSwarmWorldPosition(session.id)
    if (swarmPos) {
      camera.focusAndZoom(swarmPos, 6, 0.95)
    } else if (session.hex) {
      camera.focusAndZoom(hexGrid.axialToCartesian(session.hex), 6, 0.95)
    }
    mapActions?.focusKittyTab(session.id)
  },
  onFileClick: (fullPath, originId, _workerId) => {
    const city = findBestMatchingCity(cities, originId, fullPath)
    openFile({ path: fullPath, originId, cityId: city?.id })
  },
})

// Wire up View Playgrounds button
cityPanel.setOnViewPlaygrounds((city) => {
  playgroundViewer.show(city)
})

// State
let cities: City[] = []
let sessions: Session[] = []
let origins: ServerOrigin[] = []
let selectedHex: { q: number; r: number } | null = null
let mapActions: FrontendMapActions | null = null

// Register portolan state getters with the vellum mount layer so the
// annotation-action handlers (send-to-worker, save-as-fiber) can resolve a
// worker session and city path for any open file. See annotation-actions.
void vellumMountPromise.then(({ setPortolanMountContext }) => {
  setPortolanMountContext({
    getSessions: () => sessions,
    getCities: () => cities,
  })
})

// Move mode: when set, next click will move this city to that hex
let movingCityId: string | null = null

const stateSync = new FrontendStateSync({
  handlePanelMessage: (message) => {
    // Terminal-pin messages are routed before the city panel so scrollback +
    // live bytes flow into wterm without the HUD intercepting them.
    if (terminalPinManager.handleMessage(message)) return true
    return cityPanel.handleMessage(message)
  },
  onSocketOpen: (socket) => {
    cityPanel.setWebSocket(socket)
    terminalPinManager.setWebSocket(socket)
  },
  onStateChange: ({ cities: nextCities, sessions: nextSessions, origins: nextOrigins, activityBySessionKey, meetingBridge, isInitialState, urlCityId }) => {
    cities = nextCities
    sessions = nextSessions
    origins = nextOrigins

    // Shed ephemeral terminal pins whose backing session has disappeared.
    // Constitution: "Dormant workers show no terminal." If the worker is gone
    // from `sessions`, drop the pin client-side; DomPinLayer unmount + the
    // TerminalPinManager's dispose path will detach from the server too.
    const liveSessionIds = new Set(nextSessions.map(s => s.id))
    for (const [cityId, bucket] of ephemeralTerminalPins) {
      for (const [slug, pin] of bucket) {
        const sessionId = pin.source?.sessionId
        if (!sessionId || liveSessionIds.has(sessionId)) continue
        bucket.delete(slug)
        if (pinnedCityId === cityId) {
          domPinLayer.remove(slug)
          syncPinnedSlugs()
        }
      }
      if (bucket.size === 0) ephemeralTerminalPins.delete(cityId)
    }

    zoneRenderer.updateState(cities, sessions)
    for (const session of sessions) {
      const activitySessionKey = getActivitySessionKey(session.originId, session.tmuxSession)
      const activities = activityBySessionKey.get(activitySessionKey)
      if (activities) {
        zoneRenderer.updateWorkerActivity(activitySessionKey, activities)
      }
    }

    cityPanel.updateWorkers(sessions)
    cityPanel.updateMeetingState(meetingBridge)
    recentWorkerBar.update(cities, sessions)

    if (!isInitialState || cities.length === 0) return

    let mostRecentCity: City | null = null
    let mostRecentTime = 0
    for (const session of sessions) {
      if (session.cityId && session.lastActivity > mostRecentTime) {
        const city = cities.find(c => c.id === session.cityId)
        if (city) {
          mostRecentCity = city
          mostRecentTime = session.lastActivity
        }
      }
    }

    // `?city=X` wins over most-recent-activity heuristic. Without this, deep
    // links opened the workspace but never ran handleCityClick — HUD stayed
    // empty and pins never loaded until the user clicked the hex. See
    // hash-restore-does-not-select-city.
    const urlCity = urlCityId ? cities.find(c => c.id === urlCityId) ?? null : null
    const targetCity = urlCity || mostRecentCity || cities[0]
    console.log(
      '[InitialFocus]',
      urlCity ? `URL: ${targetCity.name}` : mostRecentCity ? `Most recent: ${targetCity.name}` : `Fallback: ${targetCity.name}`,
      sessions.length,
      'sessions,',
      sessions.filter(s => s.cityId).length,
      'with cityId'
    )
    handleCityClick(targetCity)

    if (urlCity) {
      cityPanel.hide()
      openCityWorkspace(urlCity)
    }
  },
  onActivity: ({ activitySessionKey, activities }) => {
    zoneRenderer.updateWorkerActivity(activitySessionKey, activities)
    appRuntime.scheduleWorkerHudUpdate()
  },
  onServerError: (message) => {
    console.error('[Frontend] Server error:', message)
    alert(message)
  },
})

const mapInteractions = new MapInteractionController({
  canvas: canvasOverlay,
  camera,
  hexGrid,
  zoneRenderer,
  contextMenu,
  getCities: () => cities,
  getSessions: () => sessions,
  getMovingCityId: () => movingCityId,
  setMovingCityId: (cityId) => { movingCityId = cityId },
  setSelectedHex: (hex) => { selectedHex = hex },
  handleCityClick,
  handleDeepCityPress: (city) => {
    handleCityClick(city)
    if (city.hasClaims) {
      cityPanel.hide()
      openCityWorkspace(city)
    } else {
      playgroundViewer.show(city)
    }
  },
  promptNewWorker: (city) => mapActions!.promptNewWorker(city),
  promptAddCity: (hex) => mapActions!.promptAddCity(hex),
  unpinCity: (cityId) => mapActions!.unpinCity(cityId),
  focusKittyTab: (sessionId) => mapActions!.focusKittyTab(sessionId),
  killWorker: (sessionId) => mapActions!.killWorker(sessionId),
  moveCity: (cityId, hex) => {
    // Pins follow their city: "cities are what defines place." Compute the
    // world-space delta from the city's current hex to the new one, then
    // translate every pin owned by this city by that delta. Fire-and-forget
    // after the RPC; the server doesn't know hex→world, so translation lives
    // client-side. See [[tapestry-dissolves]] Open Q1 (resolved 2026-04-15).
    const city = cities.find(c => c.id === cityId)
    mapActions!.moveCity(cityId, hex)
    if (!city) return
    const oldWorld = hexGrid.axialToCartesian(city.hex)
    const newWorld = hexGrid.axialToCartesian(hex)
    const dx = newWorld.x - oldWorld.x
    const dz = newWorld.z - oldWorld.z
    if (dx === 0 && dz === 0) return
    void translatePinsBy(cityId, dx, dz)
  },
  findNearestCity: (hex) => findNearestCity(cities, hexGrid, hex),
  getMovingPinSlug: () => movingPinSlug,
  setMovingPinSlug: (slug) => { movingPinSlug = slug },
  movePin: (slug, x, z) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    void putPin(city.id, slug, { x, z })
      .then(pin => { if (pinnedCityId === city.id) domPinLayer.upsert(pin) })
      .catch(err => console.error('[pins] move failed', err))
  },
})

mapActions = new FrontendMapActions({
  newWorkerDialog,
  sendMessage: (message) => stateSync.send(message),
  getWebSocketState: () => stateSync.getWebSocketState(),
  showCity: (city) => cityPanel.show(city),
})

const isEditableElement = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  const tagName = element.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

const onGlobalSearchKeydown = (event: KeyboardEvent): void => {
  if (event.key !== '/') return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (globalSearchPalette.isVisible()) return
  if (isEditableElement(document.activeElement)) return

  event.preventDefault()
  globalSearchPalette.show(cities, sessions)
}

window.addEventListener('keydown', onGlobalSearchKeydown)

const onGlobalHotkeys = (event: KeyboardEvent): void => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (isEditableElement(document.activeElement)) return
  if (globalSearchPalette.isVisible()) return

  const city = cityPanel.getCurrentCity()

  if (event.key === 'n' && city && cityPanel.isVisible()) {
    event.preventDefault()
    void mapActions?.promptNewWorker(city)
    return
  }

  if (event.key === 't' && city && cityPanel.isVisible()) {
    event.preventDefault()
    cityPanel.hide()
    openCityWorkspace(city)
  }
}

window.addEventListener('keydown', onGlobalHotkeys)

const appRuntime = new FrontendAppRuntime({
  renderer,
  scene,
  labelRenderer,
  camera,
  zoneRenderer,
  stateSync,
  mapInteractions,
  cityPanel,
  contextMenu,
  newWorkerDialog,
  playgroundViewer,
  clearArtifactMediaCaches,
  getCities: () => cities,
  updateWorkerHud: () => cityPanel.updateWorkers(sessions),
  isWorkerHudVisible: () => cityPanel.isVisible(),
  applyMockState: (mockCities, mockSessions) => {
    cities = mockCities
    sessions = mockSessions
    zoneRenderer.updateState(cities, sessions)
  },
  onFrame: () => {
    // Camera pan/zoom doesn't emit mousemove, so re-test hover from the
    // last-known cursor position — otherwise zooming leaves stale state.
    mapInteractions.recomputeHover()
    // DOM pins re-project to screen pixels each frame so they track the
    // camera through pan/zoom.
    domPinLayer.reanchorAll()
  },
})

installFrontendRuntimeDiagnostics({
  renderer,
  zoneRenderer,
  cityPanel,
  playgroundViewer,
  getArtifactMediaCacheStats,
  getRuntimeDisposed: () => appRuntime.isDisposed(),
  getWebSocketState: () => stateSync.getWebSocketState(),
  hasReconnectTimeout: () => stateSync.hasPendingReconnect(),
  hasReceivedInitialState: () => stateSync.getHasReceivedInitialState(),
  getWorldStats: () => ({
    cityCount: cities.length,
    sessionCount: sessions.length,
    originCount: origins.length,
    selectedHex: selectedHex ? { q: selectedHex.q, r: selectedHex.r } : null,
  }),
  getActivityStats: () => stateSync.getActivityStats(),
  getHudStats: () => appRuntime.getHudStats(),
})

stateSync.connect()
appRuntime.start()

// Drag-to-pin: long-press a fiber in the HUD, drop on the map to pin. Ghost
// element follows the cursor; release over the canvas calls screenToWorld +
// putPin. See tapestry-dissolves.
const pinDragController = new PinDragController({
  canvas,
  screenToWorld: (x, y) => camera.screenToWorld(x, y),
  getPinnedCityId: () => pinnedCityId,
  onPinned: (pin) => {
    const currentCity = cityPanel.getCurrentCity()?.id ?? pinnedCityId
    if (currentCity === pinnedCityId) {
      domPinLayer.upsert(pin)
      syncPinnedSlugs()
    }
  },
})

// File drop: drag a tab/link or local file from outside the browser onto the
// canvas to pin it. URL drops route through pinFile({ url }); local-file drops
// rely on Electron-style File.path (absent in plain Chromium — see Open Q3 of
// tapestry-dissolves for the storage decision).
const fileDropController = new FileDropController({
  canvas,
  screenToWorld: (x, y) => camera.screenToWorld(x, y),
  getPinnedCityId: () => pinnedCityId,
  onPinned: (pin) => {
    const currentCity = cityPanel.getCurrentCity()?.id ?? pinnedCityId
    if (currentCity === pinnedCityId) {
      domPinLayer.upsert(pin)
      syncPinnedSlugs()
    }
  },
})

// Dev helpers for pins (milestone 1 of tapestry-dissolves). Not a stable API —
// here so we can poke at world-space card positioning from the console before
// drag-to-pin lands.
//   __portolanPin('some-fiber', 3, -2)    // place pin at world (x=3, z=-2)
//   __portolanUnpin('some-fiber')         // remove it
// Target city defaults to the currently-open HUD; override with the 4th arg.
interface PortolanPinWindow {
  __portolanPin: (slug: string, x: number, z: number, cityId?: string) => Promise<void>
  __portolanUnpin: (slug: string, cityId?: string) => Promise<void>
  __portolanPinFile: (
    source: PinSource,
    x: number,
    z: number,
    kind?: PinKind,
    cityId?: string,
  ) => Promise<void>
}
const pinWindow = window as unknown as PortolanPinWindow
pinWindow.__portolanPin = async (slug, x, z, cityId) => {
  const targetCity = cityId ?? cityPanel.getCurrentCity()?.id ?? pinnedCityId
  if (!targetCity) { console.warn('[pins] no city selected'); return }
  const pin = await putPin(targetCity, slug, { x, z })
  if (pinnedCityId === targetCity) {
    domPinLayer.upsert(pin)
    syncPinnedSlugs()
  }
  console.log('[pins] placed', pin)
}
pinWindow.__portolanUnpin = async (slug, cityId) => {
  const targetCity = cityId ?? cityPanel.getCurrentCity()?.id ?? pinnedCityId
  if (!targetCity) { console.warn('[pins] no city selected'); return }
  await deletePin(targetCity, slug)
  if (pinnedCityId === targetCity) {
    domPinLayer.remove(slug)
    syncPinnedSlugs()
  }
}
// __portolanPinFile({ originId: 'local', path: '/abs/path/foo.pdf' }, 3, -2, 'pdf')
// __portolanPinFile({ url: 'https://...' }, 3, -2, 'html')
// Slug derives server-side from the source — re-pinning is idempotent.
pinWindow.__portolanPinFile = async (source, x, z, kind, cityId) => {
  const targetCity = cityId ?? cityPanel.getCurrentCity()?.id ?? pinnedCityId
  if (!targetCity) { console.warn('[pins] no city selected'); return }
  const pin = await pinFile(targetCity, { x, z }, source, kind)
  if (pinnedCityId === targetCity) {
    domPinLayer.upsert(pin)
    syncPinnedSlugs()
  }
  console.log('[pins] placed file pin', pin)
}

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('keydown', onGlobalSearchKeydown)
    window.removeEventListener('keydown', onGlobalHotkeys)
    globalSearchPalette.hide()
    recentWorkerBar.dispose()
    pinDragController.dispose()
    fileDropController.dispose()
    appRuntime.dispose()
  })
}
