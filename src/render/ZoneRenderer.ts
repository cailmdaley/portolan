// ZoneRenderer.ts - Renders hexes with Cartographic Warmth styling

import {
  Scene,
  Mesh,
  MeshBasicMaterial,
  Group,
  BufferGeometry,
  Object3D,
  Material,
} from 'three'
import { HexGrid } from './HexGrid'
import { createVellumPlane } from './VellumShader'
import { createRhumbLines } from './RhumbLines'
import { CitySpritesManager } from './CitySpritesManager'
import { ZoneRendererEntities } from './ZoneRendererEntities'
import type { ZoneRendererActivity } from './ZoneRendererEntities'
import { ZoneRendererLabelInteractions } from './ZoneRendererLabelInteractions'
import { ZoneRendererWorkerTooltip } from './ZoneRendererWorkerTooltip'
import type { City, Session, HexCoord } from '../state/types'

export class ZoneRenderer {
  private scene: Scene
  private hexGrid: HexGrid
  private groundPlane: Mesh | null = null
  private rhumbLinesGroup: Group | null = null

  // Hex geometry settings
  private readonly hexHeight = 0.15
  private readonly planeSize = 500  // World units (large for ~infinite appearance)

  // City sprites manager (nano-banana generated city plans)
  private citySprites: CitySpritesManager

  // Camera rotation (45° = π/4) - must match Camera.ts
  private readonly cameraRotation = Math.PI / 4

  // Track city positions for rhumb line avoidance
  private lastCityPositions: string = ''

  // Track city/worker state signatures for diffing (avoid unnecessary re-renders)
  private lastCitySignatures: Map<string, string> = new Map()

  // Store current state for sprite reload re-renders
  private currentCities: Map<string, City> = new Map()
  private currentWorkersByCity: Map<string, Session[]> = new Map()
  // Names shared by 2+ cities (e.g. `ai-futures` existing both locally and on
  // a remote host). Updated on every updateState; consulted by renderCity so
  // late sprite-load re-renders still carry the disambiguation suffix.
  private ambiguousCityNames: Set<string> = new Set()

  // Animation optimization: cache last values to skip redundant work
  private lastCameraDistance: number = -1
  private lastFontSizes: { city: number; worker: number } = { city: -1, worker: -1 }
  private lastAnimateTime: number = 0  // For delta time calculation

  private entities: ZoneRendererEntities
  private labelInteractions: ZoneRendererLabelInteractions
  private workerTooltip: ZoneRendererWorkerTooltip

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.citySprites = new CitySpritesManager()
    this.labelInteractions = new ZoneRendererLabelInteractions(workerId => this.entities.getSwarm(workerId))
    this.entities = new ZoneRendererEntities(
      this.scene,
      this.hexGrid,
      this.citySprites,
      this.labelInteractions,
      this.hexHeight,
      this.cameraRotation
    )
    this.workerTooltip = new ZoneRendererWorkerTooltip()
    this.createGroundPlane()

    // Re-render city when its custom sprite finishes loading
    this.citySprites.onSpriteLoaded((cityId) => {
      const city = this.currentCities.get(cityId)
      if (city) {
        const workers = this.currentWorkersByCity.get(cityId) || []
        this.entities.renderCity(city, workers, this.ambiguousCityNames.has(city.name))
      }
    })
  }

  private getActivitySessionKey(originId: string, tmuxSession: string): string {
    return `${originId}:${tmuxSession}`
  }

  setWorkerClickHandler(onClick: (workerId: string, tmuxSession: string) => void): void {
    this.labelInteractions.setWorkerClickHandler(onClick)
  }

  setWorkerDblClickHandler(onDblClick: (workerId: string, tmuxSession: string) => void): void {
    this.labelInteractions.setWorkerDblClickHandler(onDblClick)
  }

  /** Right-click on a worker label. Used by the host to open a context menu
   *  (e.g. "Pin terminal" — see [[constitution-terminals-in-map]]). */
  setWorkerContextMenuHandler(
    onContextMenu: (workerId: string, tmuxSession: string, clientX: number, clientY: number) => void,
  ): void {
    this.labelInteractions.setWorkerContextMenuHandler(onContextMenu)
  }

  /**
   * Set callbacks for worker label hover (triggers file tooltip from label, not just bird)
   */
  setWorkerLabelHoverHandlers(
    onHover: (workerId: string, tmuxSession: string, anchor: { x: number; y: number }) => void,
    onHoverEnd: () => void
  ): void {
    this.labelInteractions.setWorkerLabelHoverHandlers(onHover, onHoverEnd)
  }

  /**
   * Set callback for city label clicks (needed for remote cities without sprites)
   */
  setCityLabelClickHandler(onClick: (cityId: string) => void): void {
    this.labelInteractions.setCityLabelClickHandler(onClick)
  }

  /**
   * Set the screen-to-world conversion function (from camera)
   */
  setScreenToWorldConverter(converter: (x: number, y: number) => { x: number; z: number }): void {
    this.labelInteractions.setScreenToWorldConverter(converter)
  }

  /**
   * Start dragging a swarm by workerId (called from main.ts on swarm mousedown)
   * Returns true if swarm found and drag started
   */
  startSwarmDrag(workerId: string, screenX: number, screenY: number): boolean {
    return this.labelInteractions.startSwarmDrag(workerId, screenX, screenY)
  }

  /**
   * Check if currently dragging a swarm
   */
  get isDraggingSwarm(): boolean {
    return this.labelInteractions.isDraggingSwarm
  }

  /**
   * Dispose all Three.js resources in an object tree.
   * Prevents memory leaks by releasing GPU resources.
   * Skips textures marked as managed (owned by sprite managers).
   */
  private disposeObject(obj: Object3D): void {
    obj.traverse((child) => {
      // Dispose geometry for any object that has it
      if ('geometry' in child && child.geometry) {
        (child.geometry as BufferGeometry).dispose()
      }

      // Dispose materials
      if ('material' in child && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        for (const mat of materials) {
          mat.dispose()
          // Only dispose unmanaged textures (CanvasTexture from activity decals, etc.)
          const basicMat = mat as MeshBasicMaterial
          if (basicMat.map && !basicMat.map.userData?.managed) {
            basicMat.map.dispose()
          }
        }
      }
    })
  }

  private createGroundPlane(): void {
    // Vellum background - aged parchment with procedural shader
    this.groundPlane = createVellumPlane(this.planeSize, this.planeSize)
    this.groundPlane.position.y = -0.05  // Just below hex level
    this.scene.add(this.groundPlane)

    // Initial rhumb lines (will be regenerated when cities are known)
    this.updateRhumbLines([])
  }

  private updateRhumbLines(cityPositions: { x: number; z: number }[]): void {
    // Remove and dispose existing rhumb lines
    if (this.rhumbLinesGroup) {
      this.disposeObject(this.rhumbLinesGroup)
      this.scene.remove(this.rhumbLinesGroup)
    }

    // Create new rhumb lines avoiding city positions
    this.rhumbLinesGroup = createRhumbLines({
      seed: 42,
      primaryRoses: 4,
      primaryDirections: 16,
      primaryOpacity: 0.20,
      mapRadius: this.planeSize,
      clusterRadius: 25,
      avoidPositions: cityPositions,
    })
    this.scene.add(this.rhumbLinesGroup)
  }

  /**
   * Build a signature string for a city+workers state.
   * Used for diffing to avoid unnecessary re-renders.
   * `nameIsAmbiguous` changes the rendered label (origin suffix) so the
   * signature depends on it too; otherwise toggling a remote host in/out
   * would leave stale labels.
   */
  private buildCitySignature(city: City, workers: Session[], nameIsAmbiguous: boolean): string {
    const workerSigs = workers
      .map(w => `${w.id}:${w.status}:${w.name}`)
      .sort()
      .join(',')
    return `${city.name}|${nameIsAmbiguous ? city.originId : ''}|${city.hex.q},${city.hex.r}|${city.fiberCount}|${workerSigs}`
  }

  updateState(cities: City[], sessions: Session[]): void {
    // Track what should exist
    const expectedKeys = new Set<string>()
    const newSignatures = new Map<string, string>()

    // Group workers by city
    const workersByCity = new Map<string, Session[]>()
    const orphanWorkers: Session[] = []

    for (const session of sessions) {
      if (session.cityId) {
        const existing = workersByCity.get(session.cityId) || []
        existing.push(session)
        workersByCity.set(session.cityId, existing)
      } else if (session.hex) {
        // Worker without a city - render as standalone marker
        orphanWorkers.push(session)
      }
    }

    // Store current state for sprite reload re-renders
    this.currentCities.clear()
    for (const city of cities) {
      this.currentCities.set(city.id, city)
    }
    this.currentWorkersByCity = workersByCity

    // Check if city positions changed - regenerate rhumb lines if so
    const cityPositions = cities.map(c => {
      const pos = this.hexGrid.axialToCartesian(c.hex)
      return { x: pos.x, z: pos.z }
    })
    const positionsKey = JSON.stringify(cityPositions.map(p => `${p.x.toFixed(1)},${p.z.toFixed(1)}`))
    if (positionsKey !== this.lastCityPositions) {
      this.lastCityPositions = positionsKey
      this.updateRhumbLines(cityPositions)
    }

    // Detect name collisions so the label can disambiguate. Two cities with
    // the same name (e.g. `ai-futures` present both locally and on a remote
    // host) are otherwise indistinguishable on the map. Every colliding city
    // gets its origin appended; non-colliding names render unchanged.
    const nameCounts = new Map<string, number>()
    for (const city of cities) {
      nameCounts.set(city.name, (nameCounts.get(city.name) ?? 0) + 1)
    }
    const ambiguousNames = new Set(
      Array.from(nameCounts).filter(([, n]) => n > 1).map(([name]) => name),
    )
    this.ambiguousCityNames = ambiguousNames

    // Render cities with their workers (only if changed)
    for (const city of cities) {
      const key = this.hexGrid.hexKey(city.hex)
      expectedKeys.add(key)
      const cityWorkers = workersByCity.get(city.id) || []
      const nameIsAmbiguous = ambiguousNames.has(city.name)

      // Build signature and check if re-render needed
      const signature = this.buildCitySignature(city, cityWorkers, nameIsAmbiguous)
      newSignatures.set(key, signature)

      if (this.lastCitySignatures.get(key) !== signature) {
        this.entities.renderCity(city, cityWorkers, nameIsAmbiguous)
      }
    }

    // Render orphan workers (no city) as small markers
    // (renderOrphanWorker already has internal diffing)
    for (const session of orphanWorkers) {
      if (session.hex) {
        const key = this.hexGrid.hexKey(session.hex)
        expectedKeys.add(key)
        this.entities.renderOrphanWorker(session, this.getActivitySessionKey(session.originId, session.tmuxSession))
      }
    }

    this.entities.removeUnexpectedHexes(expectedKeys)

    const currentWorkerIds = new Set(sessions.map(s => s.id))

    // If the hovered worker disappears, drop tooltip state immediately.
    this.workerTooltip.clearIfWorkerMissing(currentWorkerIds)

    // Dispose swarms for workers that no longer exist
    this.entities.clearMissingWorkers(currentWorkerIds)

    // Update signature cache (removes old, adds new)
    this.lastCitySignatures = newSignatures
  }

  /**
   * Find entity at a hex position
   */
  getEntityAtHex(hex: HexCoord): { type: 'city' | 'worker' | 'empty'; entityId?: string; entityName?: string } | null {
    return this.entities.getEntityAtHex(hex)
  }

  /**
   * Find nearest city within sprite radius of a world position
   * City sprites are ~6 world units, so use radius of 3
   */
  getCityAtWorldPos(worldX: number, worldZ: number): { entityId: string } | null {
    return this.entities.getCityAtWorldPos(worldX, worldZ)
  }

  /**
   * Find worker swarm at world position
   * Uses swarm hit test for click detection
   */
  getWorkerAtWorldPos(worldX: number, worldZ: number): { workerId: string; tmuxSession: string } | null {
    return this.entities.getWorkerAtWorldPos(worldX, worldZ)
  }

  /**
   * Animate and update zoom-based label visibility
   */
  animate(cameraDistance?: number): void {
    // Calculate delta time for swarm animation
    const now = performance.now()
    const deltaTime = this.lastAnimateTime === 0 ? 1 / 60 : Math.min((now - this.lastAnimateTime) / 1000, 0.1)
    this.lastAnimateTime = now

    // Scale labels: only update when camera distance actually changed
    if (cameraDistance !== undefined && cameraDistance !== this.lastCameraDistance) {
      this.lastCameraDistance = cameraDistance

      const scale = cameraDistance <= 8 ? 1.0 : 8 / cameraDistance
      const cityFontSize = Math.round(28 * scale)   // City base: 28px
      const workerFontSize = Math.round(18 * scale) // Worker base: 18px

      // Only update DOM if font sizes actually changed
      if (cityFontSize !== this.lastFontSizes.city || workerFontSize !== this.lastFontSizes.worker) {
        this.lastFontSizes.city = cityFontSize
        this.lastFontSizes.worker = workerFontSize

        this.entities.updateLabelFontSizes(cityFontSize, workerFontSize)
      }
    }

    this.entities.updateSwarmAnimation(deltaTime, cameraDistance)
  }

  /**
   * Update activity display for a worker by tmux session
   */
  updateWorkerActivity(activitySessionKey: string, activities: ZoneRendererActivity[]): void {
    this.entities.updateWorkerActivity(activitySessionKey, activities)
  }

  /**
   * Debug utility: count scene objects for memory verification
   * Call from browser console: window.zoneRenderer?.debugResourceCounts()
   */
  debugResourceCounts(): { meshes: number; geometries: number; materials: number; textures: number; hexes: number } {
    let meshes = 0
    let geometries = 0
    let materials = 0
    const textureSet = new Set<number>()

    this.scene.traverse((obj) => {
      if (obj instanceof Mesh) {
        meshes++
        if (obj.geometry) geometries++
        if (obj.material instanceof Material) {
          materials++
          const mat = obj.material as MeshBasicMaterial
          if (mat.map) textureSet.add(mat.map.id)
        } else if (Array.isArray(obj.material)) {
          materials += obj.material.length
          obj.material.forEach(m => {
            const mat = m as MeshBasicMaterial
            if (mat.map) textureSet.add(mat.map.id)
          })
        }
      }
    })

    const counts = {
      meshes,
      geometries,
      materials,
      textures: textureSet.size,
      hexes: this.entities.hexMeshCount
    }
    console.table(counts)
    return counts
  }

  getRuntimeStats(): {
    hexMeshCount: number
    workerSwarmCount: number
    hasGroundPlane: boolean
    hasRhumbLinesGroup: boolean
    labelDragActive: boolean
    labelDragListenersAttached: boolean
    labelDragResetTimeoutPending: boolean
    tooltipVisible: boolean
    tooltipHoverTimerPending: boolean
    tooltipTargetWorkerId: string | null
    citySignatureCount: number
    currentCityCount: number
    currentWorkersByCityCount: number
  } {
    const tooltipStats = this.workerTooltip.getRuntimeStats()
    const labelInteractionStats = this.labelInteractions.getRuntimeStats()
    return {
      hexMeshCount: this.entities.hexMeshCount,
      workerSwarmCount: this.entities.workerSwarmCount,
      hasGroundPlane: this.groundPlane !== null,
      hasRhumbLinesGroup: this.rhumbLinesGroup !== null,
      labelDragActive: labelInteractionStats.active,
      labelDragListenersAttached: labelInteractionStats.listenersAttached,
      labelDragResetTimeoutPending: labelInteractionStats.resetTimeoutPending,
      tooltipVisible: tooltipStats.visible,
      tooltipHoverTimerPending: tooltipStats.hoverTimerPending,
      tooltipTargetWorkerId: tooltipStats.targetWorkerId,
      citySignatureCount: this.lastCitySignatures.size,
      currentCityCount: this.currentCities.size,
      currentWorkersByCityCount: this.currentWorkersByCity.size,
    }
  }

  setWorkerFileClickHandler(handler: (fullPath: string, originId: string, workerId: string) => void): void {
    this.workerTooltip.setWorkerFileClickHandler(handler)
  }

  /**
   * Update worker hover target for file tooltip display.
   * Tooltip appears after a 300ms hover delay.
   */
  updateWorkerFileHover(session: Session | null, anchor: { x: number; y: number } | null): void {
    this.workerTooltip.updateHover(session, anchor)
  }

  /**
   * Explicitly clear worker hover state.
   */
  clearWorkerFileHover(force = false): void {
    this.workerTooltip.clearHover(force)
  }

  /**
   * Get the world position of a worker's swarm (for camera focus)
   */
  getSwarmWorldPosition(workerId: string): { x: number, z: number } | null {
    return this.entities.getSwarmWorldPosition(workerId)
  }

  /**
   * Dispose all resources (call before recreating during HMR)
   */
  dispose(): void {
    this.labelInteractions.dispose()
    this.workerTooltip.dispose()

    this.entities.dispose()

    // Dispose scene objects
    const sceneObjects: Array<{ ref: Mesh | Group | null; clear: () => void }> = [
      { ref: this.groundPlane, clear: () => { this.groundPlane = null } },
      { ref: this.rhumbLinesGroup, clear: () => { this.rhumbLinesGroup = null } },
    ]
    for (const { ref, clear } of sceneObjects) {
      if (ref) {
        this.disposeObject(ref)
        this.scene.remove(ref)
        clear()
      }
    }

    // Dispose sprite managers
    this.citySprites.dispose()
  }
}
