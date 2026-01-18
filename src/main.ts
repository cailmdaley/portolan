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
import type { City, Session, ServerCity, ServerSession } from './state/types'
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
renderer.setClearColor(new Color(PALETTE.sand))
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

// State
let cities: City[] = []
let sessions: Session[] = []
let ws: WebSocket | null = null
// @ts-expect-error Tracked for potential state persistence
let selectedHex: { q: number; r: number } | null = null

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
}

function handleMessage(message: ServerState): void {
  // Server sends state directly: { cities: [...], sessions: [...] }
  if (message.cities && message.sessions) {
    cities = message.cities.map(normalizeCity)
    sessions = message.sessions.map(normalizeSession)
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
    // Find the session
    const session = sessions.find(s => s.id === entity.entityId)
    if (session) {
      focusKittyTab(session.id)
    }
  } else if (entity?.type === 'city' && entity.entityId) {
    // Focus on city center and show panel
    const city = cities.find(c => c.id === entity.entityId)
    if (city) {
      const pos = hexGrid.axialToCartesian(city.hex)
      camera.focusOn(pos)
      cityPanel.show(city)
    }
  }

  console.log('Clicked hex:', hex, 'Entity:', entity)
})

// Focus Kitty tab
function focusKittyTab(sessionId: string): void {
  // Send focus request to server
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'focus', sessionId }))
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
      { id: '1', name: 'hexarchy-v2', path: '/projects/hexarchy-v2', hex: { q: 0, r: 0 }, fiberCount: 3 },
      { id: '2', name: 'loom', path: '/projects/loom', hex: { q: 2, r: -1 }, fiberCount: 7 },
      { id: '3', name: 'pure-eb', path: '/projects/pure-eb', hex: { q: -2, r: 1 }, fiberCount: 0 },
    ]
    const mockSessions: Session[] = [
      { id: 's1', name: 'claude-0', cityId: '1', hex: { q: 1, r: 0 }, status: 'working' },
      { id: 's2', name: 'claude-1', cityId: '1', hex: { q: 0, r: 1 }, status: 'idle' },
      { id: 's3', name: 'claude-2', cityId: '2', hex: { q: 3, r: -1 }, status: 'attention' },
    ]
    cities = mockCities
    sessions = mockSessions
    zoneRenderer.updateState(cities, sessions)
  }
}, 1000)
