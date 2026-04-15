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
import { PinRenderer } from './render/PinRenderer'
import { DomPinLayer, isDomPinKind } from './render/DomPinLayer'

// Hoisted: lazy import the vellum mount module so DomPinLayer (built below)
// can close over it for inline markdown rendering.
const vellumMountPromise = import('./vellum/mount')
import { PinHoverPreview } from './ui/PinHoverPreview'
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

// World-space pin renderer (map-pinned vellum cards, see fiber tapestry-dissolves).
// Each pin renders as a parchment card surface; title is looked up from the HUD
// fiber list so cards read as "the fiber I pinned" rather than a raw slug.
const pinRenderer = new PinRenderer(scene, {
  fiberInfoFor: (slug) => {
    const fibers = cityPanel?.getFibers()
    if (!fibers) return null
    const hit =
      fibers.open.find(f => f.id === slug) ?? fibers.closed.find(f => f.id === slug)
    if (!hit) return null
    return { title: hit.title, status: hit.status }
  },
})
let pinnedCityId: string | null = null
let movingPinSlug: string | null = null

// DOM-overlay surface for non-fiber pins (PDFs, images, html, …). Routed by
// `pin.kind` — PinRenderer keeps fiber-kind pins; everything else lives in
// here. Reanchored each frame via `camera.worldToScreen`. See [[pin-any-file-type]].
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
    contextMenu.show(clientX, clientY, [
      {
        label: 'Move Pin',
        action: () => {
          // Move-on-next-canvas-click flow lives in MapInteractionController;
          // the DOM-pin menu participates in it by setting the same shared slug.
          // Cursor reverts on commit/escape via setMovingPinSlug.
          movingPinSlug = slug
          document.body.style.cursor = 'crosshair'
        },
      },
      {
        label: 'Unpin Card',
        action: () => {
          removePin(slug)
          syncPinnedSlugs()
          void deletePin(city.id, slug).catch(err => console.error('[pins] unpin failed', err))
        },
        danger: true,
      },
    ])
  },
  cityIdFor: () => cityPanel.getCurrentCity()?.id ?? pinnedCityId ?? undefined,
  screenToWorld: (x, y) => camera.screenToWorld(x, y),
  // Chrome-strip drag: pointer-down on the title bar of a DOM pin repositions
  // the card live; release commits via putPin. Foundational move toward the
  // floating-card primitive. See [[file-view-as-floating-card]].
  onPinMoved: (slug, x, z) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    void putPin(city.id, slug, { x, z })
      .then(pin => { if (pinnedCityId === city.id) upsertPin(pin) })
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
    void putPin(city.id, slug, { x: live.x, z: live.z }, { width, height })
      .then(pin => { if (pinnedCityId === city.id) upsertPin(pin) })
      .catch(err => console.error('[pins] resize failed', err))
  },
  // Lazy: vellum module is async-imported. Until it resolves, markdown pins
  // fall back to the link-card stub. See [[file-view-as-floating-card]].
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
})

// Repaint pin cards once EB Garamond has loaded. Initial paints happen before
// the webfont resolves, so cards land in system serif with slightly different
// word-wrap metrics than the HUD. See tapestry-dissolves.
if (document.fonts && typeof document.fonts.ready?.then === 'function') {
  void document.fonts.ready.then(() => pinRenderer.repaintAll())
}

// Extended-hover tooltip for pinned cards. Mounts vellum's FiberCard so the
// hover preview shows the same primitive the reader uses. The GraphNode is
// built from the city HUD's fiber list (portolan's Fiber shape) — enough for
// the preview variant (title + outcome + highlight) without fetching mdast.
// See tapestry-dissolves and map-pinned-card-is-canvas-texture-not-dom.
const pinHoverPreview = new PinHoverPreview({
  nodeFor: (slug) => {
    const fibers = cityPanel?.getFibers()
    if (!fibers) return null
    const hit =
      fibers.open.find(f => f.id === slug) ?? fibers.closed.find(f => f.id === slug)
    if (!hit) return null
    return {
      id: hit.id,
      slug: hit.id,
      label: hit.title,
      status: hit.status,
      kind: hit.kind,
      tags: [],
      verdict: hit.reason,
      createdAt: hit.createdAt,
    }
  },
  cityIdFor: () => pinnedCityId ?? undefined,
})

async function loadPinsForCity(cityId: string): Promise<void> {
  try {
    const pins = await listPins(cityId)
    if (pinnedCityId !== cityId) return // city changed mid-flight
    pinRenderer.setPins(pins.filter(p => !isDomPinKind(p)))
    domPinLayer.setPins(pins)
    syncPinnedSlugs()
  } catch (err) {
    console.error('[pins] load failed for', cityId, err)
  }
}

/** Translate every pin owned by `cityId` by the world-space delta. Used when a
 *  city is moved — the pins follow along. Serial PUTs keep the persisted state
 *  coherent even if one write fails; upsert as each commits so the on-screen
 *  cards slide together rather than jumping at the end. */
async function translatePinsBy(cityId: string, dx: number, dz: number): Promise<void> {
  try {
    const pins = await listPins(cityId)
    for (const pin of pins) {
      if (pinnedCityId !== cityId) return
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
        upsertPin(moved)
      } catch (err) {
        console.error('[pins] translate failed for', pin.slug, err)
      }
    }
    syncPinnedSlugs()
  } catch (err) {
    console.error('[pins] translate listPins failed for', cityId, err)
  }
}

/** Push the current set of pinned slugs to the HUD so fiber items can badge
 *  themselves as already pinned on the map. Call after any pin mutation. */
function syncPinnedSlugs(): void {
  const slugs = new Set<string>(pinRenderer.getSlugs())
  for (const slug of domPinLayer.getSlugs()) slugs.add(slug)
  cityPanel.setPinnedSlugs(slugs)
}

/** Insert a pin into whichever layer owns its kind. */
function upsertPin(pin: Pin): void {
  if (isDomPinKind(pin)) {
    pinRenderer.remove(pin.slug)
    domPinLayer.upsert(pin)
  } else {
    domPinLayer.remove(pin.slug)
    pinRenderer.upsert(pin)
  }
}

/** Remove from whichever layer holds it. */
function removePin(slug: string): void {
  pinRenderer.remove(slug)
  domPinLayer.remove(slug)
}

/** Pulse whichever layer currently owns the pin. No-op if unknown. */
function pulsePin(slug: string): void {
  if (domPinLayer.has(slug)) domPinLayer.pulse(slug)
  else if (pinRenderer.has(slug)) pinRenderer.pulse(slug)
}

/** Pan camera to a pin's anchor and pulse it. Used as "already pinned — here
 *  it is" feedback for the click-spawns-card gesture. */
function panAndPulse(slug: string): void {
  let anchor = pinRenderer.getAnchor(slug)
  if (!anchor) {
    const domPin = domPinLayer.getPin(slug)
    if (domPin) anchor = { x: domPin.x, z: domPin.z }
  }
  if (anchor) camera.focusOn({ x: anchor.x, z: anchor.z })
  pulsePin(slug)
}

/** Compute a fan-out spawn position at a city. Fiber and file pins land at the
 *  city's hex; subsequent pins get a small ring offset so they don't stack
 *  exactly. Offsets are based on the current pin count in the city's layers. */
function spawnPositionForCity(city: City): { x: number; z: number } {
  const base = hexGrid.axialToCartesian(city.hex)
  const count = pinRenderer.getSlugs().length + domPinLayer.getSlugs().length
  if (count === 0) return { x: base.x, z: base.z }
  const ring = Math.floor((count - 1) / 6) + 1
  const indexInRing = (count - 1) % 6
  const angle = (indexInRing / 6) * Math.PI * 2
  const radius = 2.2 * ring
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
  const pos = spawnPositionForCity(city)
  try {
    if (fiberMatch) {
      const slug = fiberMatch[1]
      if (pinRenderer.has(slug) || domPinLayer.has(slug)) {
        panAndPulse(slug)
        return
      }
      const pin = await putPin(city.id, slug, pos)
      if (pinnedCityId === city.id) {
        upsertPin(pin)
        syncPinnedSlugs()
        window.setTimeout(() => panAndPulse(pin.slug), 0)
      }
      return
    }
    const source: PinSource = { originId, path: fullPath }
    const kind = inferPinKindFromPath(fullPath)
    const pin = await pinFile(city.id, pos, source, kind)
    // pinFile is idempotent server-side — if the slug came back already
    // present, treat the spawn as a "find it" gesture.
    const alreadyHere = pinRenderer.has(pin.slug) || domPinLayer.has(pin.slug)
    if (pinnedCityId === city.id) {
      upsertPin(pin)
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

function inferPinKindFromPath(path: string): PinKind | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(lower)) return 'image'
  return undefined
}

// Wire up worker label click handlers (CSS2D labels need direct handlers)
zoneRenderer.setWorkerClickHandler((workerId, _tmuxSession) => {
  mapActions?.focusKittyTab(workerId)
})

zoneRenderer.setWorkerDblClickHandler((workerId, _tmuxSession) => {
  mapActions?.focusKittyTab(workerId)
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
    pinRenderer.clear()
    domPinLayer.clear()
    pinHoverPreview.hide()
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
function openCityWorkspace(city: City): void {
  activeWorkspaceHandle?.close()
  activeWorkspaceHandle = null
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    const handle = openVellumWorkspaceModal({
      cityId: city.id,
      originId: city.originId,
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
// the map. The canvas's own hover state clears whenever the cursor enters the
// HUD (canvas mouseleave), so this doesn't fight the on-map hover system —
// see tapestry-dissolves.
cityPanel.setOnPinnedFiberHover((slug) => {
  pinRenderer.setHovered(slug)
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

// Move mode: when set, next click will move this city to that hex
let movingCityId: string | null = null

const stateSync = new FrontendStateSync({
  handlePanelMessage: (message) => {
    const handled = cityPanel.handleMessage(message)
    // When the fiber list lands, repaint any pin cards whose titles were
    // placeholders (slug-only) at load time.
    if (handled && (message as { type?: string })?.type === 'fibers') {
      pinRenderer.refreshTitles()
    }
    return handled
  },
  onSocketOpen: (socket) => {
    cityPanel.setWebSocket(socket)
  },
  onStateChange: ({ cities: nextCities, sessions: nextSessions, origins: nextOrigins, activityBySessionKey, meetingBridge, isInitialState, urlCityId }) => {
    cities = nextCities
    sessions = nextSessions
    origins = nextOrigins

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

    const targetCity = mostRecentCity || cities[0]
    console.log(
      '[InitialFocus]',
      mostRecentCity ? `Most recent: ${targetCity.name}` : `Fallback: ${targetCity.name}`,
      sessions.length,
      'sessions,',
      sessions.filter(s => s.cityId).length,
      'with cityId'
    )
    const pos = hexGrid.axialToCartesian(targetCity.hex)
    camera.focusAndZoom(pos, 6, 0.95)

    if (!urlCityId) return
    const urlCity = cities.find(c => c.id === urlCityId)
    if (!urlCity) return
    cityPanel.hide()
    openCityWorkspace(urlCity)
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
    if (!city || pinnedCityId !== cityId) return
    const oldWorld = hexGrid.axialToCartesian(city.hex)
    const newWorld = hexGrid.axialToCartesian(hex)
    const dx = newWorld.x - oldWorld.x
    const dz = newWorld.z - oldWorld.z
    if (dx === 0 && dz === 0) return
    void translatePinsBy(cityId, dx, dz)
  },
  findNearestCity: (hex) => findNearestCity(cities, hexGrid, hex),
  findPinAtWorldPos: (x, z) => pinRenderer.pickAtWorld(x, z),
  handlePinClick: (slug) => {
    // Click-spawns-card makes the modal unreachable via click: a click on an
    // existing pin just confirms "yes, that's the one" — pan to it and pulse.
    // See tapestry-dissolves.
    panAndPulse(slug)
  },
  onPinHoverChange: (slug) => {
    pinRenderer.setHovered(slug)
    cityPanel.setMapHoveredFiber(slug)
    if (!slug) {
      pinHoverPreview.setHover(null, null)
      return
    }
    const worldPos = pinRenderer.getAnchor(slug)
    if (!worldPos) return
    const screen = camera.worldToScreen(worldPos.x, 0.05, worldPos.z)
    pinHoverPreview.setHover(slug, screen)
  },
  onPinContextMenu: (slug, clientX, clientY) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    // The menu is the primary surface; the hover tooltip only clutters it.
    pinHoverPreview.hide()
    contextMenu.show(clientX, clientY, [
      {
        label: 'Open Fiber',
        action: () => openFile({
          path: `${city.path}/.felt/${slug}/${slug}.md`,
          originId: city.originId,
          cityId: city.id,
        }),
      },
      {
        label: 'Move Pin',
        action: () => {
          movingPinSlug = slug
          document.body.style.cursor = 'crosshair'
          pinRenderer.setHovered(null)
        },
      },
      {
        label: 'Unpin Card',
        action: () => {
          removePin(slug)
          pinHoverPreview.hide()
          syncPinnedSlugs()
          void deletePin(city.id, slug).catch(err => console.error('[pins] unpin failed', err))
        },
        danger: true,
      },
    ])
  },
  getMovingPinSlug: () => movingPinSlug,
  setMovingPinSlug: (slug) => { movingPinSlug = slug },
  movePin: (slug, x, z) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    void putPin(city.id, slug, { x, z })
      .then(pin => { if (pinnedCityId === city.id) upsertPin(pin) })
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
    // last-known cursor position — otherwise zooming leaves the previous
    // pin lifted under a cursor that's no longer over it.
    mapInteractions.recomputeHover()
    // DOM-overlay pins (PDFs, images, …) re-project to screen pixels each
    // frame so they track the camera through pan/zoom.
    domPinLayer.reanchorAll()
    // Keep the pin hover tooltip anchored to its card while the camera is
    // panning or zooming.
    const slug = pinHoverPreview.getVisibleSlug()
    if (!slug) return
    const worldPos = pinRenderer.getAnchor(slug)
    if (!worldPos) return
    const screen = camera.worldToScreen(worldPos.x, 0.05, worldPos.z)
    pinHoverPreview.reanchor(screen)
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
      upsertPin(pin)
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
      upsertPin(pin)
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
    upsertPin(pin)
    syncPinnedSlugs()
  }
  console.log('[pins] placed', pin)
}
pinWindow.__portolanUnpin = async (slug, cityId) => {
  const targetCity = cityId ?? cityPanel.getCurrentCity()?.id ?? pinnedCityId
  if (!targetCity) { console.warn('[pins] no city selected'); return }
  await deletePin(targetCity, slug)
  if (pinnedCityId === targetCity) {
    removePin(slug)
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
    upsertPin(pin)
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
