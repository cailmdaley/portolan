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
import { installFrontendRuntimeDiagnostics } from './runtime/FrontendRuntimeDiagnostics'
import { FrontendStateSync, getActivitySessionKey } from './runtime/FrontendStateSync'
import { CityHUD } from './ui/CityHUD'
import { FileViewerModal } from './ui/FileViewerModal'
import { ContextMenu } from './ui/ContextMenu'
import { TapestryView } from './ui/TapestryView'
import { PlaygroundViewer } from './ui/PlaygroundViewer'
import { NewWorkerDialog } from './ui/NewWorkerDialog'
import { clearArtifactMediaCaches, getArtifactMediaCacheStats } from './ui/ArtifactMedia'
import type { City, Session, ServerOrigin, HexCoord } from './state/types'
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
  focusKittyTab(workerId)
})

zoneRenderer.setWorkerDblClickHandler((workerId, _tmuxSession) => {
  focusKittyTab(workerId)
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
    activateRemoteCity(city)
  } else {
    cityPanel.show(city)
    cityPanel.updateWorkers(sessions)
  }
}

// Setup file viewer modal
const fileViewerModal = new FileViewerModal()

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
  focusKittyTab(sessionId)
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

// Wire up View Playgrounds button
cityPanel.setOnViewPlaygrounds((city) => {
  playgroundViewer.show(city)
})

// State
let cities: City[] = []
let sessions: Session[] = []
let origins: ServerOrigin[] = []
let runtimeDisposed = false
let animationFrameId: number | null = null
let mockDataTimeout: ReturnType<typeof setTimeout> | null = null
let workerHudUpdateFrameId: number | null = null
let hasRuntimeCleanupRun = false
let selectedHex: { q: number; r: number } | null = null

// Move mode: when set, next click will move this city to that hex
let movingCityId: string | null = null

let totalWorkerHudUpdates = 0

function scheduleWorkerHudUpdate(): void {
  if (!cityPanel.isVisible() || workerHudUpdateFrameId !== null) return

  // Coalesce bursty activity events into at most one HUD rerender per frame.
  workerHudUpdateFrameId = requestAnimationFrame(() => {
    workerHudUpdateFrameId = null
    if (runtimeDisposed) return
    totalWorkerHudUpdates += 1
    cityPanel.updateWorkers(sessions)
  })
}

const stateSync = new FrontendStateSync({
  handlePanelMessage: (message) => cityPanel.handleMessage(message),
  onSocketOpen: (socket) => {
    cityPanel.setWebSocket(socket)
  },
  onStateChange: ({ cities: nextCities, sessions: nextSessions, origins: nextOrigins, activityBySessionKey, isInitialState, urlCityId }) => {
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
    scheduleWorkerHudUpdate()
  },
  onServerError: (message) => {
    console.error('[Frontend] Server error:', message)
    alert(message)
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
  getRuntimeDisposed: () => runtimeDisposed,
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
  getHudStats: () => ({
    hasPendingWorkerUpdateFrame: workerHudUpdateFrameId !== null,
    totalWorkerHudUpdates,
  }),
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
  promptNewWorker,
  promptAddCity,
  unpinCity,
  focusKittyTab,
  killWorker,
  moveCity,
  findNearestCity: (hex) => findNearestCity(cities, hexGrid, hex),
})

// Prompt for new worker name and create it
async function promptNewWorker(city: City): Promise<void> {
  const result = await newWorkerDialog.show(city.name)
  if (!result) return  // Cancelled

  stateSync.send({
    type: 'newWorker',
    cityPath: city.path,
    name: result.name || undefined,
    cli: result.cli || undefined,
    chrome: result.chrome || undefined,
    continue: result.continue || undefined,
  })
}

// Pin a new city at the given hex
function promptAddCity(hex: HexCoord): void {
  const path = window.prompt('Enter the full path for the new city:')
  if (!path) return

  if (!stateSync.send({
    type: 'pinCity',
    path: path.trim(),
    position: { q: hex.q, r: hex.r },
  })) {
    console.error('WebSocket not ready, state:', stateSync.getWebSocketState())
  }
}

// Unpin a city
function unpinCity(cityId: string): void {
  stateSync.send({
    type: 'unpinCity',
    cityId,
  })
}

// Move a city to a new hex position
function moveCity(cityId: string, hex: HexCoord): void {
  stateSync.send({
    type: 'moveCity',
    cityId,
    newPosition: { q: hex.q, r: hex.r },
  })
}

// Kill a worker (tmux session)
function killWorker(sessionId: string): void {
  stateSync.send({
    type: 'killWorker',
    sessionId,
  })
}

// Focus Kitty tab
function focusKittyTab(sessionId: string): void {
  stateSync.send({ type: 'focus', sessionId })
}

// Activate dormant remote city (SSH + start agent)
async function activateRemoteCity(city: City): Promise<void> {

  try {
    const response = await fetch(`http://localhost:4004/activate-city?cityId=${city.id}`, {
      method: 'POST',
    })

    const result = await response.json()

    if (response.ok) {
      // Agent will connect and sessions will appear via WebSocket
      // Show panel while waiting
      cityPanel.show(city)
    } else {
      console.error(`[Activate] Failed: ${result.error}`)
      alert(`Failed to activate remote city: ${result.error}`)
    }
  } catch (err) {
    console.error('[Activate] Network error:', err)
    alert(`Failed to connect to server`)
  }
}

// Window resize handler
function resizeHandler(): void {
  renderer.setSize(window.innerWidth, window.innerHeight)
  labelRenderer.setSize(window.innerWidth, window.innerHeight)
  camera.resize()
}
window.addEventListener('resize', resizeHandler)
// Render loop
function animate(): void {
  if (runtimeDisposed) return
  animationFrameId = requestAnimationFrame(animate)

  // Animate (breathing pulse, label visibility, distance fading)
  zoneRenderer.animate(camera.cameraDistance)

  renderer.render(scene, camera.camera)
  labelRenderer.render(scene, camera.camera)
}

// Start
stateSync.connect()
animate()

// Add some mock data for testing when server is not available
mockDataTimeout = setTimeout(() => {
  if (cities.length === 0) {
    const mockCities: City[] = [
      { id: '1', name: 'portolan-v2', path: '/projects/portolan-v2', hex: { q: 0, r: 0 }, fiberCount: 3, hasClaims: false, hasPlaygrounds: true, isDormant: false, originId: 'local' },
      { id: '2', name: 'loom', path: '/projects/loom', hex: { q: 2, r: -1 }, fiberCount: 7, hasClaims: true, hasPlaygrounds: false, isDormant: false, originId: 'local' },
      { id: '3', name: 'pure-eb', path: '/projects/pure-eb', hex: { q: -2, r: 1 }, fiberCount: 0, hasClaims: true, hasPlaygrounds: false, isDormant: true, originId: 'remote-candide' },
    ]
    const mockSessions: Session[] = [
      { id: 's1', name: 'claude-0', tmuxSession: 'mock-0', cityId: '1', hex: { q: 1, r: 0 }, status: 'working', originId: 'local', lastActivity: Date.now() },
      { id: 's2', name: 'claude-1', tmuxSession: 'mock-1', cityId: '1', hex: { q: 0, r: 1 }, status: 'idle', originId: 'local', lastActivity: Date.now() },
      { id: 's3', name: 'claude-2', tmuxSession: 'mock-2', cityId: '2', hex: { q: 3, r: -1 }, status: 'idle', originId: 'local', lastActivity: Date.now() },
    ]
    cities = mockCities
    sessions = mockSessions
    zoneRenderer.updateState(cities, sessions)
  }
  mockDataTimeout = null
}, 1000)

function cleanupRuntime(): void {
  if (hasRuntimeCleanupRun) return
  hasRuntimeCleanupRun = true
  runtimeDisposed = true

  // Stop async loops and reconnect timers before disposing owned resources.
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  if (mockDataTimeout) {
    clearTimeout(mockDataTimeout)
    mockDataTimeout = null
  }
  if (workerHudUpdateFrameId !== null) {
    cancelAnimationFrame(workerHudUpdateFrameId)
    workerHudUpdateFrameId = null
  }

  // Close WebSocket and prevent reconnection attempts.
  stateSync.dispose()

  mapInteractions.dispose()
  window.removeEventListener('resize', resizeHandler)

  // Dispose UI panels (removes DOM and detaches document listeners).
  cityPanel.dispose()
  fileViewerModal.dispose()
  contextMenu.dispose()
  newWorkerDialog.dispose()
  tapestryView.dispose()
  playgroundViewer.dispose()

  // Dispose renderer components in reverse initialization order.
  camera.dispose()
  zoneRenderer.dispose()
  renderer.dispose()

  // Clear shared UI media caches so HMR and prod cleanup follow the same teardown path.
  clearArtifactMediaCaches()

  // Clean up DOM elements.
  labelRenderer.domElement.remove()
}

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupRuntime()
  })
}
