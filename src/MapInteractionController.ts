import type { HexGrid } from './render/HexGrid'
import type { ZoneRenderer } from './render/ZoneRenderer'
import type { Camera } from './render/Camera'
import type { ContextMenu } from './ui/ContextMenu'
import type { City, Session, HexCoord } from './state/types'

type GetCities = () => City[]
type GetSessions = () => Session[]

interface MapInteractionControllerOptions {
  canvas: HTMLCanvasElement
  camera: Camera
  hexGrid: HexGrid
  zoneRenderer: ZoneRenderer
  contextMenu: ContextMenu
  getCities: GetCities
  getSessions: GetSessions
  getMovingCityId: () => string | null
  setMovingCityId: (cityId: string | null) => void
  setSelectedHex: (hex: HexCoord | null) => void
  handleCityClick: (city: City) => void
  handleDeepCityPress: (city: City) => void
  promptNewWorker: (city: City) => void | Promise<void>
  promptAddCity: (hex: HexCoord) => void
  unpinCity: (cityId: string) => void
  focusKittyTab: (sessionId: string) => void
  killWorker: (sessionId: string) => void
  moveCity: (cityId: string, hex: HexCoord) => void
  findNearestCity: (hex: HexCoord) => City | null
  /** Optional hit test for map-pinned vellum cards (tapestry-dissolves). */
  findPinAtWorldPos?: (x: number, z: number) => string | null
  /** Called when a pinned card is clicked. Return value unused. */
  handlePinClick?: (slug: string) => void
  /** Called on mouse move with the slug of the hovered pin, or null. */
  onPinHoverChange?: (slug: string | null) => void
  /** Right-click over a pinned card. Handler shows its own context menu. */
  onPinContextMenu?: (slug: string, clientX: number, clientY: number) => void
}

export class MapInteractionController {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: Camera
  private readonly hexGrid: HexGrid
  private readonly zoneRenderer: ZoneRenderer
  private readonly contextMenu: ContextMenu
  private readonly getCities: GetCities
  private readonly getSessions: GetSessions
  private readonly getMovingCityId: () => string | null
  private readonly setMovingCityId: (cityId: string | null) => void
  private readonly setSelectedHex: (hex: HexCoord | null) => void
  private readonly handleCityClick: (city: City) => void
  private readonly handleDeepCityPress: (city: City) => void
  private readonly promptNewWorker: (city: City) => void | Promise<void>
  private readonly promptAddCity: (hex: HexCoord) => void
  private readonly unpinCity: (cityId: string) => void
  private readonly focusKittyTab: (sessionId: string) => void
  private readonly killWorker: (sessionId: string) => void
  private readonly moveCity: (cityId: string, hex: HexCoord) => void
  private readonly findNearestCity: (hex: HexCoord) => City | null
  private readonly findPinAtWorldPos?: (x: number, z: number) => string | null
  private readonly handlePinClick?: (slug: string) => void
  private readonly onPinHoverChange?: (slug: string | null) => void
  private readonly onPinContextMenu?: (slug: string, clientX: number, clientY: number) => void
  private hoveredPinSlug: string | null = null

  private forceMouseX = 0
  private forceMouseY = 0
  private forceTouchFired = false
  private workerCycleIndex = -1
  private cityCycleIndex = -1

  constructor(options: MapInteractionControllerOptions) {
    this.canvas = options.canvas
    this.camera = options.camera
    this.hexGrid = options.hexGrid
    this.zoneRenderer = options.zoneRenderer
    this.contextMenu = options.contextMenu
    this.getCities = options.getCities
    this.getSessions = options.getSessions
    this.getMovingCityId = options.getMovingCityId
    this.setMovingCityId = options.setMovingCityId
    this.setSelectedHex = options.setSelectedHex
    this.handleCityClick = options.handleCityClick
    this.handleDeepCityPress = options.handleDeepCityPress
    this.promptNewWorker = options.promptNewWorker
    this.promptAddCity = options.promptAddCity
    this.unpinCity = options.unpinCity
    this.focusKittyTab = options.focusKittyTab
    this.killWorker = options.killWorker
    this.moveCity = options.moveCity
    this.findNearestCity = options.findNearestCity
    this.findPinAtWorldPos = options.findPinAtWorldPos
    this.handlePinClick = options.handlePinClick
    this.onPinHoverChange = options.onPinHoverChange
    this.onPinContextMenu = options.onPinContextMenu

    document.addEventListener('contextmenu', this.onDocumentContextMenu)
    document.addEventListener('click', this.onForceClickCapture, true)
    this.canvas.addEventListener('mousedown', this.onCanvasMouseDownCapture, true)
    this.canvas.addEventListener('click', this.onCanvasClick)
    this.canvas.addEventListener('dblclick', this.onCanvasDoubleClick)
    this.canvas.addEventListener('mousemove', this.onCanvasMouseMove)
    this.canvas.addEventListener('mouseleave', this.onCanvasMouseLeave)
    this.canvas.addEventListener('webkitmouseforcewillbegin', this.onCanvasForceWillBegin)
    this.canvas.addEventListener('webkitmouseforcedown', this.onCanvasForceDown)
    window.addEventListener('keydown', this.onEscapeKey)
    window.addEventListener('keydown', this.onCycleKeys)
  }

  dispose(): void {
    document.removeEventListener('contextmenu', this.onDocumentContextMenu)
    document.removeEventListener('click', this.onForceClickCapture, true)
    this.canvas.removeEventListener('mousedown', this.onCanvasMouseDownCapture, true)
    this.canvas.removeEventListener('click', this.onCanvasClick)
    this.canvas.removeEventListener('dblclick', this.onCanvasDoubleClick)
    this.canvas.removeEventListener('mousemove', this.onCanvasMouseMove)
    this.canvas.removeEventListener('mouseleave', this.onCanvasMouseLeave)
    this.canvas.removeEventListener('webkitmouseforcewillbegin', this.onCanvasForceWillBegin)
    this.canvas.removeEventListener('webkitmouseforcedown', this.onCanvasForceDown)
    window.removeEventListener('keydown', this.onEscapeKey)
    window.removeEventListener('keydown', this.onCycleKeys)
  }

  private readonly onDocumentContextMenu = (e: MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target !== this.canvas && !target.closest('.label-container')) return
    e.preventDefault()
    this.handleContextMenu(e.clientX, e.clientY)
  }

  private readonly onCanvasMouseDownCapture = (e: MouseEvent): void => {
    if (e.button !== 0) return

    const worldPos = this.camera.screenToWorld(e.clientX, e.clientY)
    const workerHit = this.zoneRenderer.getWorkerAtWorldPos(worldPos.x, worldPos.z)
    if (!workerHit) return

    if (this.zoneRenderer.startSwarmDrag(workerHit.workerId, e.clientX, e.clientY)) {
      this.zoneRenderer.clearWorkerFileHover(true)
      e.stopPropagation()
    }
  }

  private readonly onCanvasClick = (e: MouseEvent): void => {
    if (this.camera.dragging || this.zoneRenderer.isDraggingSwarm) return
    this.zoneRenderer.clearWorkerFileHover(true)

    const worldPos = this.camera.screenToWorld(e.clientX, e.clientY)
    const hex = this.hexGrid.cartesianToHex(worldPos.x, worldPos.z)
    const movingCityId = this.getMovingCityId()

    if (movingCityId) {
      this.moveCity(movingCityId, hex)
      this.setMovingCityId(null)
      document.body.style.cursor = ''
      return
    }

    // Pin card hit-test runs first: pinned vellum cards sit on top of the hex
    // world and should "win" over the underlying city/worker for click.
    const pinHit = this.findPinAtWorldPos?.(worldPos.x, worldPos.z)
    if (pinHit && this.handlePinClick) {
      this.handlePinClick(pinHit)
      return
    }

    const workerHit = this.zoneRenderer.getWorkerAtWorldPos(worldPos.x, worldPos.z)
    if (workerHit) {
      const session = this.getSessions().find(s => s.id === workerHit.workerId)
      if (session) {
        this.setSelectedHex(session.hex || hex)
        this.focusKittyTab(session.id)
        return
      }
    }

    const cityHit = this.zoneRenderer.getCityAtWorldPos(worldPos.x, worldPos.z)
    if (cityHit) {
      const city = this.getCities().find(c => c.id === cityHit.entityId)
      if (city) {
        this.handleCityClick(city)
        return
      }
    }

    const entity = this.zoneRenderer.getEntityAtHex(hex)
    if (entity?.type === 'worker' && entity.entityId) {
      this.setSelectedHex(hex)
      this.focusKittyTab(entity.entityId)
      return
    }

    this.setSelectedHex(null)
  }

  private readonly onCanvasDoubleClick = (e: MouseEvent): void => {
    if (this.camera.dragging) return

    const worldPos = this.camera.screenToWorld(e.clientX, e.clientY)
    const hex = this.hexGrid.cartesianToHex(worldPos.x, worldPos.z)
    // Pin-hit short-circuit: a second click on the same card shouldn't fall
    // through to promptNewWorker for an underlying city.
    if (this.findPinAtWorldPos?.(worldPos.x, worldPos.z)) return
    const workerHit = this.zoneRenderer.getWorkerAtWorldPos(worldPos.x, worldPos.z)
    if (workerHit) {
      this.focusKittyTab(workerHit.workerId)
      return
    }

    const cityHit = this.zoneRenderer.getCityAtWorldPos(worldPos.x, worldPos.z)
    if (cityHit) {
      const city = this.getCities().find(c => c.id === cityHit.entityId)
      if (city) {
        void this.promptNewWorker(city)
        return
      }
    }

    const entity = this.zoneRenderer.getEntityAtHex(hex)
    if (entity?.type === 'worker' && entity.entityId) {
      this.focusKittyTab(entity.entityId)
      return
    }

    const nearestCity = this.findNearestCity(hex)
    if (nearestCity && this.hexGrid.distance(hex, nearestCity.hex) <= 3) {
      void this.promptNewWorker(nearestCity)
    }
  }

  private readonly onCanvasMouseMove = (e: MouseEvent): void => {
    this.forceMouseX = e.clientX
    this.forceMouseY = e.clientY

    if (this.camera.dragging || this.getMovingCityId()) {
      this.zoneRenderer.clearWorkerFileHover()
      return
    }

    const worldPos = this.camera.screenToWorld(e.clientX, e.clientY)
    const pinSlug = this.findPinAtWorldPos?.(worldPos.x, worldPos.z) ?? null
    if (pinSlug !== this.hoveredPinSlug) {
      this.hoveredPinSlug = pinSlug
      this.onPinHoverChange?.(pinSlug)
    }
    if (pinSlug) {
      this.canvas.style.cursor = 'pointer'
      this.zoneRenderer.clearWorkerFileHover()
      return
    }
    const workerHit = this.zoneRenderer.getWorkerAtWorldPos(worldPos.x, worldPos.z)
    if (workerHit) {
      this.canvas.style.cursor = 'grab'
      const session = this.getSessions().find(s => s.id === workerHit.workerId)
      if (session) {
        const swarmPos = this.zoneRenderer.getSwarmWorldPosition(workerHit.workerId)
        const tooltipAnchor = swarmPos
          ? this.camera.worldToScreen(swarmPos.x, 0.7, swarmPos.z)
          : { x: e.clientX, y: e.clientY }
        this.zoneRenderer.updateWorkerFileHover(session, tooltipAnchor)
      } else {
        this.zoneRenderer.clearWorkerFileHover()
      }
      return
    }

    this.zoneRenderer.clearWorkerFileHover()

    if (this.zoneRenderer.getCityAtWorldPos(worldPos.x, worldPos.z)) {
      this.canvas.style.cursor = 'var(--cursor-bird)'
      return
    }

    this.canvas.style.cursor = ''
  }

  private readonly onCanvasMouseLeave = (): void => {
    this.zoneRenderer.clearWorkerFileHover()
    if (this.hoveredPinSlug !== null) {
      this.hoveredPinSlug = null
      this.onPinHoverChange?.(null)
    }
    if (!this.getMovingCityId()) {
      this.canvas.style.cursor = ''
    }
  }

  private readonly onCanvasForceWillBegin = (e: Event): void => {
    e.preventDefault()
  }

  private readonly onCanvasForceDown = (): void => {
    if (this.camera.dragging) return
    this.forceTouchFired = true

    const worldPos = this.camera.screenToWorld(this.forceMouseX, this.forceMouseY)
    const cityHit = this.zoneRenderer.getCityAtWorldPos(worldPos.x, worldPos.z)
    if (cityHit) {
      const city = this.getCities().find(c => c.id === cityHit.entityId)
      if (city && (city.hasClaims || city.hasPlaygrounds)) {
        this.handleDeepCityPress(city)
        return
      }
    }

    this.handleContextMenu(this.forceMouseX, this.forceMouseY)
  }

  private readonly onForceClickCapture = (e: MouseEvent): void => {
    if (!this.forceTouchFired) return
    e.stopPropagation()
    this.forceTouchFired = false
  }

  private readonly onEscapeKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return

    if (this.getMovingCityId()) {
      this.setMovingCityId(null)
      document.body.style.cursor = ''
    }
    this.zoneRenderer.clearWorkerFileHover(true)
  }

  private readonly onCycleKeys = (e: KeyboardEvent): void => {
    if (!e.metaKey) return
    if (e.code !== 'Digit9' && e.code !== 'Digit0') return

    const direction = e.code === 'Digit0' ? 1 : -1
    const sessions = this.getSessions()
    const cities = this.getCities()

    if (e.altKey && !e.ctrlKey) {
      e.preventDefault()
      if (sessions.length === 0) return
      this.workerCycleIndex = (this.workerCycleIndex + direction + sessions.length) % sessions.length
      const session = sessions[this.workerCycleIndex]
      this.focusKittyTab(session.id)
      const swarmPos = this.zoneRenderer.getSwarmWorldPosition(session.id)
      if (swarmPos) {
        this.camera.focusAndZoom(swarmPos, 6, 0.95)
      }
      return
    }

    if (e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const activeCities = cities.filter(c => sessions.some(s => s.cityId === c.id))
      if (activeCities.length === 0) return
      this.cityCycleIndex = (this.cityCycleIndex + direction + activeCities.length) % activeCities.length
      this.handleCityClick(activeCities[this.cityCycleIndex])
    }
  }

  private handleContextMenu(clientX: number, clientY: number): void {
    if (this.camera.dragging) return

    const worldPos = this.camera.screenToWorld(clientX, clientY)
    // Pin context menu takes precedence over underlying city/worker — same as
    // the click path, so right-click on a pinned card always targets the pin.
    const pinHit = this.findPinAtWorldPos?.(worldPos.x, worldPos.z)
    if (pinHit && this.onPinContextMenu) {
      this.onPinContextMenu(pinHit, clientX, clientY)
      return
    }
    const hex = this.hexGrid.cartesianToHex(worldPos.x, worldPos.z)
    const cityHit = this.zoneRenderer.getCityAtWorldPos(worldPos.x, worldPos.z)

    if (cityHit) {
      const city = this.getCities().find(c => c.id === cityHit.entityId)
      if (city) {
        this.contextMenu.show(clientX, clientY, [
          { label: 'New Worker', action: () => void this.promptNewWorker(city) },
          { label: 'Move City', action: () => this.startMoveCity(city.id) },
          { label: 'Remove City', action: () => this.unpinCity(city.id), danger: true },
        ])
      }
      return
    }

    const entity = this.zoneRenderer.getEntityAtHex(hex)
    if (entity?.type === 'worker' && entity.entityId) {
      const session = this.getSessions().find(s => s.id === entity.entityId)
      if (session) {
        this.contextMenu.show(clientX, clientY, [
          { label: 'Focus Tab', action: () => this.focusKittyTab(session.id) },
          { label: 'Retire Worker', action: () => this.killWorker(session.id), danger: true },
        ])
      }
      return
    }

    const nearestCity = this.findNearestCity(hex)
    if (nearestCity && this.hexGrid.distance(hex, nearestCity.hex) <= 3) {
      this.contextMenu.show(clientX, clientY, [
        { label: `New Worker (${nearestCity.name})`, action: () => void this.promptNewWorker(nearestCity) },
      ])
      return
    }

    this.contextMenu.show(clientX, clientY, [
      { label: 'Add City Here', action: () => this.promptAddCity(hex) },
    ])
  }

  private startMoveCity(cityId: string): void {
    this.setMovingCityId(cityId)
    document.body.style.cursor = 'crosshair'
  }
}
