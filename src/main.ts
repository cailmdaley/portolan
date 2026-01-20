// main.ts - Bootstrap and render loop

import {
  Scene,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Color,
} from 'three'
import { HexGrid } from './render/HexGrid'
import { ZoneRenderer } from './render/ZoneRenderer'
import { Camera } from './render/Camera'
import { CityPanel } from './ui/CityPanel'
import { ContextMenu } from './ui/ContextMenu'
import { ViewSwitcher, type GlobalView } from './ui/ViewSwitcher'
import { ViewOverlay } from './ui/ViewOverlay'
import { TabbedPlansView } from './ui/TabbedPlansView'
import { ClaimsDashboard } from './ui/ClaimsDashboard'
import type { City, Session, ServerCity, ServerSession, ServerOrigin, HexCoord } from './state/types'
import { PALETTE, normalizeCity, normalizeSession } from './state/types'

// Get canvas
const canvas = document.getElementById('canvas') as HTMLCanvasElement

// Setup renderer
const renderer = new WebGLRenderer({
  canvas,
  antialias: true,
})
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(new Color(PALETTE.bgPrimary))
renderer.shadowMap.enabled = true

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
const hexGrid = new HexGrid(100, 1.0)

// Setup camera
const camera = new Camera(canvas)

// Setup zone renderer
const zoneRenderer = new ZoneRenderer(scene, hexGrid)

// Setup city panel
const cityPanel = new CityPanel()

// Setup context menu
const contextMenu = new ContextMenu()

// Setup view switching
const viewOverlay = new ViewOverlay()
const tabbedPlansView = new TabbedPlansView()

// View URLs from environment or defaults
const PLOT_SERVER_URL = 'http://localhost:8873'  // Plot server gallery

// Track current view state (used in handleViewChange)
// @ts-expect-error Tracked for potential state persistence
let currentView: GlobalView = 'map'

function handleViewChange(view: GlobalView): void {
  currentView = view

  if (view === 'map') {
    // Return to hex grid
    viewOverlay.hide()
    tabbedPlansView.hide()
    canvas.style.display = 'block'
  } else if (view === 'plots') {
    // Show plot server gallery
    canvas.style.display = 'none'
    tabbedPlansView.hide()
    viewOverlay.show(PLOT_SERVER_URL)
  } else if (view === 'plans') {
    // Show tabbed plannotator view
    canvas.style.display = 'none'
    viewOverlay.hide()
    tabbedPlansView.show(origins)
  }
}

// @ts-expect-error ViewSwitcher self-registers on DOM, ref retained to prevent GC
const viewSwitcher = new ViewSwitcher(handleViewChange)

// Setup claims dashboard
const claimsDashboard = new ClaimsDashboard()

// Wire up View Claims button
cityPanel.setOnViewClaims((city) => {
  // Proxy through hexarchy server to handle both local and remote cities
  const dashboardUrl = `http://${window.location.hostname}:4004/claims-dashboard?cityId=${encodeURIComponent(city.id)}`
  claimsDashboard.show(city, dashboardUrl)
})


// Activity type from server
interface Activity {
  tool: string
  summary?: string
  timestamp: number
}

// State
let cities: City[] = []
let sessions: Session[] = []
let origins: ServerOrigin[] = []
let ws: WebSocket | null = null
// @ts-expect-error Tracked for potential state persistence
let selectedHex: { q: number; r: number } | null = null

// Activity stream per tmux session
const activityBySession = new Map<string, Activity[]>()
const MAX_ACTIVITIES_PER_SESSION = 10

// Handle incoming activity event
function handleActivityEvent(activity: { tmuxSession: string; tool: string; summary?: string; timestamp: number }): void {
  console.log('[Activity]', activity.tmuxSession, activity.tool, activity.summary || '')
  // Store activity
  let activities = activityBySession.get(activity.tmuxSession)
  if (!activities) {
    activities = []
    activityBySession.set(activity.tmuxSession, activities)
  }
  activities.unshift({
    tool: activity.tool,
    summary: activity.summary,
    timestamp: activity.timestamp,
  })
  if (activities.length > MAX_ACTIVITIES_PER_SESSION) {
    activities.pop()
  }

  // Update ZoneRenderer worker marker activity
  zoneRenderer.updateWorkerActivity(activity.tmuxSession, activities)
}

// Connect to server
function connectWebSocket(): void {
  const wsUrl = `ws://${window.location.hostname}:4004`
  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log('Connected to hexarchy server')
    cityPanel.setWebSocket(ws!)
  }

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data)
      // Check if city panel handles this message type
      if (!cityPanel.handleMessage(message)) {
        handleMessage(message)
      }
    } catch (e) {
      console.error('Failed to parse message:', e)
    }
  }

  ws.onclose = () => {
    console.log('Disconnected from server, reconnecting...')
    setTimeout(connectWebSocket, 2000)
  }

  ws.onerror = (e) => {
    console.error('WebSocket error:', e)
  }
}

interface ServerState {
  cities: ServerCity[]
  sessions: ServerSession[]
  origins?: ServerOrigin[]
}

interface ConfirmUnpinMessage {
  type: 'confirmUnpin'
  cityId: string
  cityName: string
  sessionCount: number
}

interface CityPinnedMessage {
  type: 'cityPinned'
  city: ServerCity
}

interface CityUnpinnedMessage {
  type: 'cityUnpinned'
  cityId: string
}

interface ErrorMessage {
  type: 'error'
  message: string
}

interface ActivityMessage {
  type: 'activity'
  activity: {
    tmuxSession: string
    tool: string
    summary?: string
    timestamp: number
  }
}

type ServerMessage = ServerState | ConfirmUnpinMessage | CityPinnedMessage | CityUnpinnedMessage | ErrorMessage | ActivityMessage

function handleMessage(message: ServerMessage): void {
  console.log('[Frontend] Received message:', 'type' in message ? message.type : 'state update')

  // Handle persistence-related messages
  if ('type' in message) {
    if (message.type === 'confirmUnpin') {
      // Show confirmation dialog
      const msg = message as ConfirmUnpinMessage
      const confirmed = window.confirm(
        `City "${msg.cityName}" has ${msg.sessionCount} active session(s).\n\n` +
        `The city will remain visible while sessions are active.\n` +
        `Remove persistence anyway?`
      )
      if (confirmed && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'confirmUnpinCity', cityId: msg.cityId }))
      }
      return
    }

    if (message.type === 'cityPinned') {
      console.log('[Frontend] City pinned successfully:', (message as CityPinnedMessage).city)
      return
    }

    if (message.type === 'cityUnpinned') {
      console.log('[Frontend] City unpinned:', (message as CityUnpinnedMessage).cityId)
      return
    }

    if (message.type === 'error') {
      const errorMsg = (message as ErrorMessage).message
      console.error('[Frontend] Server error:', errorMsg)
      // Show user-facing errors in an alert
      alert(errorMsg)
      return
    }

    if (message.type === 'activity') {
      const actMsg = message as ActivityMessage
      handleActivityEvent(actMsg.activity)
      return
    }
  }

  // Server sends state directly: { cities: [...], sessions: [...], origins: [...] }
  const state = message as ServerState
  if (state.cities && state.sessions) {
    cities = state.cities.map(normalizeCity)
    sessions = state.sessions.map(normalizeSession)
    if (state.origins) {
      origins = state.origins
      // Update tabbed plans view if visible (handles new agents connecting)
      tabbedPlansView.update(origins)
    }
    zoneRenderer.updateState(cities, sessions)
  }
}

// Click handling
canvas.addEventListener('click', (e) => {
  // Ignore clicks that were drags
  if (camera.dragging) return

  const worldPos = camera.screenToWorld(e.clientX, e.clientY)
  const hex = hexGrid.cartesianToHex(worldPos.x, worldPos.z)
  const entity = zoneRenderer.getEntityAtHex(hex)

  // Update selection visual
  selectedHex = hex
  zoneRenderer.setSelection(hex)

  if (entity?.type === 'worker' && entity.entityId) {
    // Click worker → focus Kitty terminal directly
    const session = sessions.find(s => s.id === entity.entityId)
    if (session) {
      focusKittyTab(session.id)
      cityPanel.hide()
    }
  } else if (entity?.type === 'city' && entity.entityId) {
    // Focus on city center
    const city = cities.find(c => c.id === entity.entityId)
    if (city) {
      const pos = hexGrid.axialToCartesian(city.hex)
      camera.focusOn(pos)

      // Dormant remote city → activate agent
      if (city.isDormant && city.originId !== 'local') {
        activateRemoteCity(city)
      } else {
        cityPanel.show(city)
      }
    }
  }

  console.log('Clicked hex:', hex, 'Entity:', entity)
})

// Double-click to create workers/cities
canvas.addEventListener('dblclick', (e) => {
  // Ignore if dragging
  if (camera.dragging) return

  const worldPos = camera.screenToWorld(e.clientX, e.clientY)
  const hex = hexGrid.cartesianToHex(worldPos.x, worldPos.z)
  const entity = zoneRenderer.getEntityAtHex(hex)

  if (entity?.type === 'city' && entity.entityId) {
    // Double-click city → new worker
    const city = cities.find(c => c.id === entity.entityId)
    if (city) {
      promptNewWorker(city)
    }
  } else if (entity?.type === 'empty' || !entity) {
    // Check distance to nearest city
    const nearestCity = findNearestCity(hex)

    if (nearestCity && hexGrid.distance(hex, nearestCity.hex) <= 3) {
      // Within 3 tiles of a city → new worker
      promptNewWorker(nearestCity)
    } else {
      // Far from any city → add city
      promptAddCity(hex)
    }
  }
})

// Right-click context menu
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()

  // Ignore if dragging
  if (camera.dragging) return

  const worldPos = camera.screenToWorld(e.clientX, e.clientY)
  const hex = hexGrid.cartesianToHex(worldPos.x, worldPos.z)
  const entity = zoneRenderer.getEntityAtHex(hex)

  if (entity?.type === 'worker' && entity.entityId) {
    // Worker right-click: show retire option
    const session = sessions.find(s => s.id === entity.entityId)
    if (session) {
      contextMenu.show(e.clientX, e.clientY, [
        {
          label: 'Focus Tab',
          action: () => focusKittyTab(session.id),
        },
        {
          label: 'Retire Worker',
          action: () => killWorker(session.id),
          danger: true,
        },
      ])
    }
  } else if (entity?.type === 'city' && entity.entityId) {
    // City right-click: show remove option
    const city = cities.find(c => c.id === entity.entityId)
    if (city) {
      contextMenu.show(e.clientX, e.clientY, [
        {
          label: 'New Worker',
          action: () => promptNewWorker(city),
        },
        {
          label: 'Remove City',
          action: () => unpinCity(city.id),
          danger: true,
        },
      ])
    }
  } else if (entity?.type === 'empty' || !entity) {
    // Check distance to nearest city
    const nearestCity = findNearestCity(hex)

    if (nearestCity && hexGrid.distance(hex, nearestCity.hex) <= 3) {
      // Within 3 tiles of a city: offer new worker
      contextMenu.show(e.clientX, e.clientY, [
        {
          label: `New Worker (${nearestCity.name})`,
          action: () => promptNewWorker(nearestCity),
        },
      ])
    } else {
      // Far from any city: offer new city
      contextMenu.show(e.clientX, e.clientY, [
        {
          label: 'Add City Here',
          action: () => promptAddCity(hex),
        },
      ])
    }
  }
})

// Find nearest city to a hex
function findNearestCity(hex: HexCoord): City | null {
  if (cities.length === 0) return null

  let nearest: City | null = null
  let minDist = Infinity

  for (const city of cities) {
    const dist = hexGrid.distance(hex, city.hex)
    if (dist < minDist) {
      minDist = dist
      nearest = city
    }
  }

  return nearest
}

// Prompt for new worker name and create it
function promptNewWorker(city: City): void {
  const name = window.prompt(`Name for new worker in ${city.name}:`, '')
  if (name === null) return  // Cancelled

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'newWorker',
      cityPath: city.path,
      name: name.trim() || undefined,  // undefined if empty (will auto-generate)
    }))
  }
}

// Pin a new city at the given hex
function promptAddCity(hex: HexCoord): void {
  const path = window.prompt('Enter the full path for the new city:')
  if (!path) return

  console.log('Sending pinCity message:', { path: path.trim(), position: hex })

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'pinCity',
      path: path.trim(),
      position: { q: hex.q, r: hex.r },
    }))
    console.log('pinCity message sent')
  } else {
    console.error('WebSocket not ready, readyState:', ws?.readyState)
  }
}

// Unpin a city
function unpinCity(cityId: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'unpinCity',
      cityId,
    }))
  }
}

// Kill a worker (tmux session)
function killWorker(sessionId: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'killWorker',
      sessionId,
    }))
  }
}

// Focus Kitty tab
function focusKittyTab(sessionId: string): void {
  // Send focus request to server
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'focus', sessionId }))
  }
}

// Activate dormant remote city (SSH + start agent)
async function activateRemoteCity(city: City): Promise<void> {
  console.log(`[Activate] Starting agent for remote city: ${city.name} (${city.originId})`)

  try {
    const response = await fetch(`http://localhost:4004/activate-city?cityId=${city.id}`, {
      method: 'POST',
    })

    const result = await response.json()

    if (response.ok) {
      console.log(`[Activate] ${result.message}`)
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

// Window resize
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  camera.resize()
})

// Render loop
function animate(): void {
  requestAnimationFrame(animate)
  // Pass camera distance for screen-space label scaling
  const cameraDistance = camera.camera.position.length()
  zoneRenderer.animate(cameraDistance)
  renderer.render(scene, camera.camera)
}

// Start
connectWebSocket()
animate()

// Add some mock data for testing when server is not available
setTimeout(() => {
  if (cities.length === 0) {
    console.log('No server data, adding mock cities for visualization')
    const mockCities: City[] = [
      { id: '1', name: 'hexarchy-v2', path: '/projects/hexarchy-v2', hex: { q: 0, r: 0 }, fiberCount: 3, hasClaims: false, isDormant: false, originId: 'local' },
      { id: '2', name: 'loom', path: '/projects/loom', hex: { q: 2, r: -1 }, fiberCount: 7, hasClaims: true, isDormant: false, originId: 'local' },
      { id: '3', name: 'pure-eb', path: '/projects/pure-eb', hex: { q: -2, r: 1 }, fiberCount: 0, hasClaims: true, isDormant: true, originId: 'remote-candide' },
    ]
    const mockSessions: Session[] = [
      { id: 's1', name: 'claude-0', tmuxSession: 'mock-0', cityId: '1', hex: { q: 1, r: 0 }, status: 'working' },
      { id: 's2', name: 'claude-1', tmuxSession: 'mock-1', cityId: '1', hex: { q: 0, r: 1 }, status: 'idle' },
      { id: 's3', name: 'claude-2', tmuxSession: 'mock-2', cityId: '2', hex: { q: 3, r: -1 }, status: 'idle' },
    ]
    cities = mockCities
    sessions = mockSessions
    zoneRenderer.updateState(cities, sessions)
  }
}, 1000)
