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
import { listPins, putPin, deletePin } from './state/layoutClient'
import { PinDragController } from './PinDragController'
import { MapInteractionController } from './MapInteractionController'
import { FrontendMapActions } from './FrontendMapActions'
import { installFrontendRuntimeDiagnostics } from './runtime/FrontendRuntimeDiagnostics'
import { getActivitySessionKey } from './runtime/FrontendActivityStore'
import { FrontendStateSync } from './runtime/FrontendStateSync'
import { FrontendAppRuntime } from './runtime/FrontendAppRuntime'
import { CityHUD } from './ui/CityHUD'
import { ContextMenu } from './ui/ContextMenu'
import { TapestryView } from './ui/TapestryView'
import { PlaygroundViewer } from './ui/PlaygroundViewer'
import { NewWorkerDialog } from './ui/NewWorkerDialog'
import { GlobalSearchPalette } from './ui/GlobalSearchPalette'
import { RecentWorkerBar } from './ui/RecentWorkerBar'
import { clearArtifactMediaCaches, getArtifactMediaCacheStats } from './ui/ArtifactMedia'
import type { City, Session, ServerOrigin } from './state/types'
import { findBestMatchingCity, findNearestCity, getCityWorkers } from './state/cityLookup'
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

async function loadPinsForCity(cityId: string): Promise<void> {
  try {
    const pins = await listPins(cityId)
    if (pinnedCityId !== cityId) return // city changed mid-flight
    pinRenderer.setPins(pins)
  } catch (err) {
    console.error('[pins] load failed for', cityId, err)
  }
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
  if (tapestryView.isVisible()) return

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
    void loadPinsForCity(city.id)
  }
}

// Vellum is the file viewer. React modal mounted via openVellumFileModal.
// See vellum-in-portolan: portolan's FileViewerModal has been retired from the
// user-facing path; all file opens go through vellum + PortolanAdapter.
const vellumMountPromise = import('./vellum/mount')

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

// Wire up file search click from city panel to vellum.
cityPanel.setOnOpenFile((fullPath, originId, _cityPath, cityId, line) => {
  openFile({ path: fullPath, originId, cityId, jumpToLine: line })
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

// Tapestry view — retained under a legacy flag for side-by-side comparison
// during the tapestry-dissolves migration. Default path is vellum's workspace.
// TODO(tapestry-dissolves): delete TapestryView + friends once vellum workspace is proven.
const tapestryView = new TapestryView()
tapestryView.setOnGetWorkers((city) => getCityWorkers(city, sessions))
tapestryView.setOnOpenFile((filePath, city, line) => {
  openFile({ path: filePath, originId: city.originId, cityId: city.id, jumpToLine: line })
})

const useLegacyTapestry = new URLSearchParams(window.location.search).has('legacyTapestry')

// View Claims button → vellum workspace (or legacy TapestryView when flagged).
cityPanel.setOnViewClaims((city) => {
  cityPanel.hide()
  if (useLegacyTapestry) tapestryView.show(city)
  else openCityWorkspace(city)
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
    if (useLegacyTapestry) tapestryView.show(urlCity)
    else openCityWorkspace(urlCity)
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
      if (useLegacyTapestry) tapestryView.show(city)
      else openCityWorkspace(city)
    } else {
      playgroundViewer.show(city)
    }
  },
  promptNewWorker: (city) => mapActions!.promptNewWorker(city),
  promptAddCity: (hex) => mapActions!.promptAddCity(hex),
  unpinCity: (cityId) => mapActions!.unpinCity(cityId),
  focusKittyTab: (sessionId) => mapActions!.focusKittyTab(sessionId),
  killWorker: (sessionId) => mapActions!.killWorker(sessionId),
  moveCity: (cityId, hex) => mapActions!.moveCity(cityId, hex),
  findNearestCity: (hex) => findNearestCity(cities, hexGrid, hex),
  findPinAtWorldPos: (x, z) => pinRenderer.pickAtWorld(x, z),
  handlePinClick: (slug) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
    openFile({
      path: `${city.path}/.felt/${slug}/${slug}.md`,
      originId: city.originId,
      cityId: city.id,
    })
  },
  onPinHoverChange: (slug) => pinRenderer.setHovered(slug),
  onPinContextMenu: (slug, clientX, clientY) => {
    const city = cityPanel.getCurrentCity() ?? cities.find(c => c.id === pinnedCityId) ?? null
    if (!city) return
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
        label: 'Unpin Card',
        action: () => {
          pinRenderer.remove(slug)
          void deletePin(city.id, slug).catch(err => console.error('[pins] unpin failed', err))
        },
        danger: true,
      },
    ])
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
    if (useLegacyTapestry) tapestryView.show(city)
    else openCityWorkspace(city)
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
  tapestryView,
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
})

installFrontendRuntimeDiagnostics({
  renderer,
  zoneRenderer,
  cityPanel,
  tapestryView,
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
    if (currentCity === pinnedCityId) pinRenderer.upsert(pin)
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
}
const pinWindow = window as unknown as PortolanPinWindow
pinWindow.__portolanPin = async (slug, x, z, cityId) => {
  const targetCity = cityId ?? cityPanel.getCurrentCity()?.id ?? pinnedCityId
  if (!targetCity) { console.warn('[pins] no city selected'); return }
  const pin = await putPin(targetCity, slug, { x, z })
  if (pinnedCityId === targetCity) pinRenderer.upsert(pin)
  console.log('[pins] placed', pin)
}
pinWindow.__portolanUnpin = async (slug, cityId) => {
  const targetCity = cityId ?? cityPanel.getCurrentCity()?.id ?? pinnedCityId
  if (!targetCity) { console.warn('[pins] no city selected'); return }
  await deletePin(targetCity, slug)
  if (pinnedCityId === targetCity) pinRenderer.remove(slug)
}

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('keydown', onGlobalSearchKeydown)
    window.removeEventListener('keydown', onGlobalHotkeys)
    globalSearchPalette.hide()
    recentWorkerBar.dispose()
    pinDragController.dispose()
    appRuntime.dispose()
  })
}
