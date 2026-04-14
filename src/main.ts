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
import { MapInteractionController } from './MapInteractionController'
import { FrontendMapActions } from './FrontendMapActions'
import { installFrontendRuntimeDiagnostics } from './runtime/FrontendRuntimeDiagnostics'
import { getActivitySessionKey } from './runtime/FrontendActivityStore'
import { FrontendStateSync } from './runtime/FrontendStateSync'
import { FrontendAppRuntime } from './runtime/FrontendAppRuntime'
import { CityHUD } from './ui/CityHUD'
import { FileViewerModal } from './ui/FileViewerModal'
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
}

// Setup file viewer modal
const fileViewerModal = new FileViewerModal()

// Vellum seam: open vellum's React FileViewerModal against the portolan adapter.
// Activated via ?vellumDebug=<encoded-path>[&vellumOrigin=<id>][&vellumCity=<id>]
// or window.__mountVellumFileViewer({ path, originId?, cityId?, editable? }).
// See vellum-in-portolan fiber; the shell lives in vellum (FileViewerModal), the
// host only installs the global seam and URL-param auto-open.
void installVellumSeam()
async function installVellumSeam(): Promise<void> {
  const { openVellumFileModal } = await import('./vellum/mount')
  ;(window as unknown as {
    __mountVellumFileViewer: (opts: { path: string; originId?: string; cityId?: string; editable?: boolean; jumpToLine?: number }) => void
  }).__mountVellumFileViewer = (opts) => { openVellumFileModal(opts) }

  const params = new URLSearchParams(window.location.search)
  const debugPath = params.get('vellumDebug')
  if (debugPath) {
    const lineParam = params.get('vellumLine')
    const jumpToLine = lineParam ? Number(lineParam) : undefined
    openVellumFileModal({
      path: debugPath,
      originId: params.get('vellumOrigin') ?? undefined,
      cityId: params.get('vellumCity') ?? undefined,
      editable: params.get('vellumEdit') === '1',
      jumpToLine: Number.isFinite(jumpToLine) ? jumpToLine : undefined,
    })
  }
}

// Wire up file click from worker hover tooltip to file viewer
zoneRenderer.setWorkerFileClickHandler((fullPath, originId, workerId) => {
  const city = findBestMatchingCity(cities, originId, fullPath)
  fileViewerModal.show(fullPath, originId, workerId, undefined, city?.path, city?.id)
})

// Wire up worker lookup for send-to-worker feature
fileViewerModal.setOnGetWorkers(async (originId: string, path: string) => {
  const city = findBestMatchingCity(cities, originId, path)
  if (!city) return []

  // Return workers (sessions) assigned to this city
  return sessions
    .filter(s => s.cityId === city.id && s.originId === originId)
    .map(s => ({ id: s.id, name: s.name, tmuxSession: s.tmuxSession }))
})

// Wire up file search click from city panel to file viewer
cityPanel.setOnOpenFile((fullPath, originId, cityPath, cityId, line) => {
  fileViewerModal.show(fullPath, originId, undefined, undefined, cityPath, cityId, line)
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

// Tapestry view — native DAG visualization for fibers
const tapestryView = new TapestryView()

// Wire up View Claims button — uses native TapestryView
cityPanel.setOnViewClaims((city) => {
  cityPanel.hide()
  tapestryView.show(city)
})

// Wire up worker lookup for tapestry view
tapestryView.setOnGetWorkers((city) => getCityWorkers(city, sessions))

// Wire up file navigation from tapestry view — open files in file viewer
tapestryView.setOnOpenFile((filePath, city, line) => {
  fileViewerModal.show(filePath, city.originId, undefined, undefined, city.path, city.id, line)
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
  onFileClick: (fullPath, originId, workerId) => {
    const city = findBestMatchingCity(cities, originId, fullPath)
    fileViewerModal.show(fullPath, originId, workerId, undefined, city?.path, city?.id)
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
  handlePanelMessage: (message) => cityPanel.handleMessage(message),
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
    tapestryView.show(urlCity)
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
      tapestryView.show(city)
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
    tapestryView.show(city)
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
  fileViewerModal,
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
  fileViewerModal,
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

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('keydown', onGlobalSearchKeydown)
    window.removeEventListener('keydown', onGlobalHotkeys)
    globalSearchPalette.hide()
    recentWorkerBar.dispose()
    appRuntime.dispose()
  })
}
