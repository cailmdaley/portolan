// ZoneRenderer.ts - Renders hexes with Cartographic Warmth styling

import {
  Scene,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Shape,
  ExtrudeGeometry,
  Group,
  PlaneGeometry,
  DoubleSide,
  CanvasTexture,
  LineLoop,
  BufferGeometry,
  LineBasicMaterial,
  Vector3,
  Object3D,
  Material,
} from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { HexGrid } from './HexGrid'
import { createVellumPlane } from './VellumShader'
import { createRhumbLines } from './RhumbLines'
import { CitySpritesManager } from './CitySpritesManager'
import { ShipSpritesManager } from './ShipSpritesManager'
import type { City, Session, HexCoord, ConversationMessage } from '../state/types'
import { PALETTE } from '../state/types'
import { ConversationCard } from '../ui/ConversationCard'

interface Activity {
  tool: string
  summary?: string
  timestamp: number
}

interface HexMeshData {
  group: Group
  hex: HexCoord
  type: 'city' | 'worker' | 'empty'
  entityId?: string
  entityName?: string  // Worker name for tooltip
  tmuxSession?: string  // For workers - to route activity events
  mesh?: Mesh  // For animation (worker breathing pulse)
  status?: 'idle' | 'working'  // Worker status for animation
  activityMesh?: Mesh  // Activity ground decal
  labelObject?: CSS2DObject  // HTML label (CSS2D for OpenType features)
  workerLabels?: CSS2DObject[]  // Worker labels clustered on city sprite
  cityName?: string  // For toggling label text
  workerCount?: number  // For toggling label text
}

export class ZoneRenderer {
  private scene: Scene
  private hexGrid: HexGrid
  private hexMeshes: Map<string, HexMeshData> = new Map()
  private groundPlane: Mesh | null = null
  private rhumbLinesGroup: Group | null = null
  private selectionRing: Group | null = null

  // Hex geometry settings
  private readonly hexHeight = 0.15
  private readonly planeSize = 500  // World units (large for ~infinite appearance)

  // City sprites manager (nano-banana generated city plans)
  private citySprites: CitySpritesManager

  // Ship sprites manager (worker ships)
  private shipSprites: ShipSpritesManager

  // Camera rotation (45° = π/4) - must match Camera.ts
  private readonly cameraRotation = Math.PI / 4

  // Callback for worker label clicks (since CSS2D labels need direct handlers)
  private onWorkerClick: ((workerId: string, tmuxSession: string) => void) | null = null
  private onWorkerDblClick: ((workerId: string, tmuxSession: string) => void) | null = null

  // Track city positions for rhumb line avoidance
  private lastCityPositions: string = ''

  // Track city/worker state signatures for diffing (avoid unnecessary re-renders)
  private lastCitySignatures: Map<string, string> = new Map()

  // Store current state for sprite reload re-renders
  private currentCities: Map<string, City> = new Map()
  private currentWorkersByCity: Map<string, Session[]> = new Map()

  // Animation optimization: cache last values to skip redundant work
  private lastCameraDistance: number = -1
  private lastFontSizes: { city: number; worker: number } = { city: -1, worker: -1 }
  private workingWorkerIds: Set<string> = new Set()  // Only workers that need breathing animation

  // Conversation cards - map-pinned worker conversations
  private conversationCards: Map<string, ConversationCard> = new Map()  // workerId -> card
  private onCardFileClick: ((fullPath: string, originId: string, workerId: string) => void) | null = null
  private topZIndex = 100  // Track highest z-index for bringing cards to front

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.citySprites = new CitySpritesManager()
    this.shipSprites = new ShipSpritesManager()
    this.createGroundPlane()

    // Re-render city when its custom sprite finishes loading
    this.citySprites.onSpriteLoaded((cityId) => {
      const city = this.currentCities.get(cityId)
      if (city) {
        const workers = this.currentWorkersByCity.get(cityId) || []
        this.renderCity(city, workers)
      }
    })
  }

  /**
   * Set callback for worker label clicks
   */
  setWorkerClickHandler(onClick: (workerId: string, tmuxSession: string) => void): void {
    this.onWorkerClick = onClick
  }

  /**
   * Set callback for worker label double-clicks
   */
  setWorkerDblClickHandler(onDblClick: (workerId: string, tmuxSession: string) => void): void {
    this.onWorkerDblClick = onDblClick
  }

  /**
   * Convert hex-aligned offset to world XZ coordinates.
   * For elements rotated 60° to match hex orientation.
   * +X = right along hex axis, +Y = up along hex axis
   */
  private hexToWorld(hexX: number, hexY: number): { x: number; z: number } {
    const angle = this.cameraRotation + Math.PI / 3  // 45° + 60° = 105°
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return {
      x: hexX * cos - hexY * sin,
      z: -hexX * sin - hexY * cos,
    }
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

  private createHexShape(scale = 1): Shape {
    const r = this.hexGrid.hexRadius * scale
    const shape = new Shape()

    // Pointy-top hexagon (matches axialToCartesian spacing)
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      const x = r * Math.cos(angle)
      const y = r * Math.sin(angle)
      if (i === 0) {
        shape.moveTo(x, y)
      } else {
        shape.lineTo(x, y)
      }
    }
    shape.closePath()

    return shape
  }

  private createHexMesh(
    color: number,
    scale = 1,
    height = this.hexHeight
  ): Mesh {
    const shape = this.createHexShape(scale)
    const geometry = new ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 2,
    })

    const material = new MeshStandardMaterial({
      color,
      roughness: 0.8,
      metalness: 0.1,
    })

    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    mesh.castShadow = true
    mesh.receiveShadow = true

    return mesh
  }

  /**
   * Create a hex edge outline (just the border, no fill)
   */
  private createHexEdge(scale = 1, opacity = 0.15): LineLoop {
    const r = this.hexGrid.hexRadius * scale
    const points: Vector3[] = []

    // Pointy-top hexagon
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      points.push(new Vector3(r * Math.cos(angle), 0, r * Math.sin(angle)))
    }

    const geometry = new BufferGeometry().setFromPoints(points)
    const material = new LineBasicMaterial({
      color: 0x6B5B4B,  // Warm brown
      transparent: true,
      opacity,
    })

    return new LineLoop(geometry, material)
  }

  /**
   * Add hex grid overlay around a city (3-hex radius)
   */
  private addCityHexGrid(group: Group, centerHex: HexCoord): void {
    const radius = 4  // 4-hex radius around city
    const hexes = this.hexGrid.getHexesInRadius(centerHex, radius)

    for (const hex of hexes) {
      const relPos = this.hexGrid.axialToCartesian(hex)
      const centerPos = this.hexGrid.axialToCartesian(centerHex)

      const edge = this.createHexEdge(0.98, 0.10)
      edge.position.set(relPos.x - centerPos.x, 0.05, relPos.z - centerPos.z)  // Above sprite
      group.add(edge)
    }
  }

  renderCity(city: City, workers: Session[] = []): void {
    const key = this.hexGrid.hexKey(city.hex)

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(city.hex)

    // Light hex grid around city for spatial reference
    this.addCityHexGrid(group, city.hex)

    // City sprite - nano-banana generated city plan, lying flat on vellum
    const texture = this.citySprites.getSprite(city)

    if (texture) {
      // Use a flat plane mesh instead of billboard sprite
      // With 1 hex = 1 world unit, sprite covers 3 hex radius (7 hexes across)
      const spriteSize = 6.5  // World units diameter (3 hex radius)
      const geometry = new PlaneGeometry(spriteSize, spriteSize)
      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: DoubleSide,
        depthWrite: false,  // Prevent z-fighting with vellum
      })
      const cityMesh = new Mesh(geometry, material)
      cityMesh.rotation.x = -Math.PI / 2  // Lie flat on XZ plane
      cityMesh.position.y = 0.02  // Just above vellum
      group.add(cityMesh)
    } else {
      // Fallback: small marker while sprites load
      const fallbackMesh = this.createHexMesh(PALETTE.cityHex, 0.3, 0.05)
      group.add(fallbackMesh)
    }

    // City label - above the sprite
    const labelDiv = document.createElement('div')
    labelDiv.className = 'city-label'
    labelDiv.textContent = city.name
    const labelObject = new CSS2DObject(labelDiv)
    labelObject.position.set(0, 1.5, 0)  // Above center
    group.add(labelObject)

    // Workers as ships positioned around the southern arc of the city
    // Camera is at +Z looking toward -Z, so "south" (below on screen) is +Z direction
    const workerLabels: CSS2DObject[] = []
    const shipTexture = this.shipSprites.getShipTexture()
    const shipSize = 2.0  // World units
    const shipRadius = 3.0  // Distance from city center
    const arcStart = Math.PI * 0.25  // Start at 45° (right-front)
    const arcEnd = Math.PI * 0.75    // End at 135° (left-front)

    workers.forEach((worker, i) => {
      // Distribute ships along the southern arc
      const arcSpan = arcEnd - arcStart
      const angle = workers.length === 1
        ? Math.PI * 0.5  // Single worker at center-front (directly towards camera)
        : arcStart + (arcSpan * i / (workers.length - 1))

      const shipX = Math.cos(angle) * shipRadius
      const shipZ = Math.sin(angle) * shipRadius

      // Ship sprite mesh
      if (shipTexture) {
        const shipGeometry = new PlaneGeometry(shipSize, shipSize)
        const shipMaterial = new MeshBasicMaterial({
          map: shipTexture,
          transparent: true,
          side: DoubleSide,
          depthWrite: false,
        })
        const shipMesh = new Mesh(shipGeometry, shipMaterial)
        shipMesh.rotation.x = -Math.PI / 2  // Lie flat on XZ plane
        shipMesh.position.set(shipX, 0.03, shipZ)  // Just above vellum
        // Store worker info for click detection
        shipMesh.userData = { workerId: worker.id, tmuxSession: worker.tmuxSession }
        group.add(shipMesh)
      }

      // Worker label attached to ship
      const workerDiv = document.createElement('div')
      workerDiv.className = worker.status === 'working' ? 'worker-label working' : 'worker-label'
      workerDiv.textContent = worker.name
      workerDiv.dataset.workerId = worker.id
      workerDiv.dataset.tmuxSession = worker.tmuxSession

      // Clickable
      workerDiv.addEventListener('click', (e) => {
        e.stopPropagation()
        if (this.onWorkerClick) this.onWorkerClick(worker.id, worker.tmuxSession)
      })
      workerDiv.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        if (this.onWorkerDblClick) this.onWorkerDblClick(worker.id, worker.tmuxSession)
      })

      const workerLabelObj = new CSS2DObject(workerDiv)
      workerLabelObj.position.set(shipX, -0.8, shipZ)  // Below ship
      group.add(workerLabelObj)
      workerLabels.push(workerLabelObj)
    })

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, {
      group, hex: city.hex, type: 'city', entityId: city.id,
      labelObject, workerLabels,
      cityName: city.name, workerCount: workers.length
    })
  }

  /**
   * Render an orphan worker (no city) as a ship
   * These are workers that exist but aren't associated with any city
   */
  renderOrphanWorker(session: Session): void {
    if (!session.hex) return

    const key = this.hexGrid.hexKey(session.hex)

    // Check if worker already exists - just update status
    const existing = this.hexMeshes.get(key)
    if (existing && existing.type === 'worker' && existing.entityId === session.id) {
      // Update label class for status change
      if (existing.status !== session.status && existing.labelObject) {
        existing.labelObject.element.className = session.status === 'working'
          ? 'worker-label working'
          : 'worker-label'
        existing.status = session.status
      }
      return
    }

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(session.hex)

    // Ship sprite for orphan worker
    const shipTexture = this.shipSprites.getShipTexture()
    let shipMesh: Mesh | undefined

    if (shipTexture) {
      const shipSize = 1.2
      const shipGeometry = new PlaneGeometry(shipSize, shipSize)
      const shipMaterial = new MeshBasicMaterial({
        map: shipTexture,
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
      })
      shipMesh = new Mesh(shipGeometry, shipMaterial)
      shipMesh.rotation.x = -Math.PI / 2  // Lie flat
      shipMesh.position.y = 0.03
      group.add(shipMesh)
    } else {
      // Fallback: small hex marker
      const color = session.status === 'working' ? PALETTE.workerActive : PALETTE.workerIdle
      shipMesh = this.createHexMesh(color, 0.3, 0.05)
      group.add(shipMesh)
    }

    // Worker label
    const labelDiv = document.createElement('div')
    labelDiv.className = session.status === 'working' ? 'worker-label working' : 'worker-label'
    labelDiv.textContent = session.name
    const labelObject = new CSS2DObject(labelDiv)
    labelObject.position.y = 0.5
    group.add(labelObject)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, {
      group,
      hex: session.hex,
      type: 'worker',
      entityId: session.id,
      entityName: session.name,
      tmuxSession: session.tmuxSession,
      mesh: shipMesh,
      status: session.status,
      labelObject,
    })
  }

  private removeHex(key: string): void {
    const data = this.hexMeshes.get(key)
    if (!data) return

    // Clean up CSS2D label DOM elements
    data.labelObject?.element.remove()
    data.workerLabels?.forEach(label => label.element.remove())

    // Dispose Three.js resources before removing from scene
    this.disposeObject(data.group)
    this.scene.remove(data.group)
    this.hexMeshes.delete(key)
  }

  /**
   * Build a signature string for a city+workers state.
   * Used for diffing to avoid unnecessary re-renders.
   */
  private buildCitySignature(city: City, workers: Session[]): string {
    const workerSigs = workers
      .map(w => `${w.id}:${w.status}:${w.name}`)
      .sort()
      .join(',')
    return `${city.name}|${city.hex.q},${city.hex.r}|${city.fiberCount}|${workerSigs}`
  }

  updateState(cities: City[], sessions: Session[]): void {
    // Track what should exist
    const expectedKeys = new Set<string>()
    const newSignatures = new Map<string, string>()

    // Rebuild working workers set for animation optimization
    this.workingWorkerIds.clear()

    // Group workers by city
    const workersByCity = new Map<string, Session[]>()
    const orphanWorkers: Session[] = []

    for (const session of sessions) {
      // Track working orphan workers for breathing animation (city workers don't have meshes)
      if (session.status === 'working' && session.hex && !session.cityId) {
        this.workingWorkerIds.add(this.hexGrid.hexKey(session.hex))
      }

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

    // Render cities with their workers (only if changed)
    for (const city of cities) {
      const key = this.hexGrid.hexKey(city.hex)
      expectedKeys.add(key)
      const cityWorkers = workersByCity.get(city.id) || []

      // Build signature and check if re-render needed
      const signature = this.buildCitySignature(city, cityWorkers)
      newSignatures.set(key, signature)

      if (this.lastCitySignatures.get(key) !== signature) {
        this.renderCity(city, cityWorkers)
      }
    }

    // Render orphan workers (no city) as small markers
    // (renderOrphanWorker already has internal diffing)
    for (const session of orphanWorkers) {
      if (session.hex) {
        const key = this.hexGrid.hexKey(session.hex)
        expectedKeys.add(key)
        this.renderOrphanWorker(session)
      }
    }

    // Remove hexes that no longer exist (except empty background hexes)
    for (const [key, data] of this.hexMeshes) {
      if (!expectedKeys.has(key) && data.type !== 'empty') {
        this.removeHex(key)
      }
    }

    // Close conversation cards for workers that no longer exist
    const currentWorkerIds = new Set(sessions.map(s => s.id))
    for (const workerId of this.conversationCards.keys()) {
      if (!currentWorkerIds.has(workerId)) {
        this.closeConversationCard(workerId)
      }
    }

    // Update signature cache (removes old, adds new)
    this.lastCitySignatures = newSignatures
  }

  getHexAtPosition(x: number, z: number): HexCoord {
    return this.hexGrid.cartesianToHex(x, z)
  }

  /**
   * Find entity at a hex position
   */
  getEntityAtHex(hex: HexCoord): { type: 'city' | 'worker' | 'empty'; entityId?: string; entityName?: string } | null {
    const key = this.hexGrid.hexKey(hex)
    const data = this.hexMeshes.get(key)
    if (data) {
      return { type: data.type, entityId: data.entityId, entityName: data.entityName }
    }
    return null
  }

  /**
   * Find nearest city within sprite radius of a world position
   * City sprites are ~6 world units, so use radius of 3
   */
  getCityAtWorldPos(worldX: number, worldZ: number): { entityId: string } | null {
    const spriteRadius = 3.25  // 3 hex radius (matches sprite)
    let nearest: { entityId: string; dist: number } | null = null

    for (const [, data] of this.hexMeshes) {
      if (data.type === 'city' && data.entityId) {
        const pos = this.hexGrid.axialToCartesian(data.hex)
        const dist = Math.sqrt((pos.x - worldX) ** 2 + (pos.z - worldZ) ** 2)
        if (dist <= spriteRadius && (!nearest || dist < nearest.dist)) {
          nearest = { entityId: data.entityId, dist }
        }
      }
    }

    return nearest ? { entityId: nearest.entityId } : null
  }

  /**
   * Find worker ship at world position
   * Checks ship meshes that have userData with worker info
   */
  getWorkerAtWorldPos(worldX: number, worldZ: number): { workerId: string; tmuxSession: string } | null {
    const hitRadius = 1.2  // Ship click radius
    let nearestDist = Infinity
    let nearestWorker: { workerId: string; tmuxSession: string } | null = null

    for (const [, data] of this.hexMeshes) {
      if (data.type === 'city') {
        const cityPos = this.hexGrid.axialToCartesian(data.hex)
        // Check all children of the city group for ship meshes
        data.group.traverse((child) => {
          if (child instanceof Mesh && child.userData?.workerId) {
            // Ship position in world space
            const shipWorldX = cityPos.x + child.position.x
            const shipWorldZ = cityPos.z + child.position.z
            const dist = Math.sqrt((shipWorldX - worldX) ** 2 + (shipWorldZ - worldZ) ** 2)
            if (dist <= hitRadius && dist < nearestDist) {
              nearestDist = dist
              nearestWorker = {
                workerId: child.userData.workerId as string,
                tmuxSession: child.userData.tmuxSession as string,
              }
            }
          }
        })
      }
    }

    return nearestWorker
  }

  /**
   * Create a ring shape (hex with hex hole)
   */
  private createRingShape(outerScale: number, innerScale: number): Shape {
    const outerR = this.hexGrid.hexRadius * outerScale
    const innerR = this.hexGrid.hexRadius * innerScale

    // Outer hex (pointy-top to match grid)
    const shape = new Shape()
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      const x = outerR * Math.cos(angle)
      const y = outerR * Math.sin(angle)
      if (i === 0) {
        shape.moveTo(x, y)
      } else {
        shape.lineTo(x, y)
      }
    }
    shape.closePath()

    // Inner hex hole (counter-clockwise for hole, pointy-top)
    const hole = new Shape()
    for (let i = 5; i >= 0; i--) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      const x = innerR * Math.cos(angle)
      const y = innerR * Math.sin(angle)
      if (i === 5) {
        hole.moveTo(x, y)
      } else {
        hole.lineTo(x, y)
      }
    }
    hole.closePath()
    shape.holes.push(hole)

    return shape
  }

  /**
   * Set selection highlight on a hex
   */
  setSelection(hex: HexCoord | null): void {
    // Remove and dispose existing selection ring
    if (this.selectionRing) {
      this.disposeObject(this.selectionRing)
      this.scene.remove(this.selectionRing)
      this.selectionRing = null
    }

    if (!hex) return

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(hex)

    // Create ring (gold highlight - Porch Morning)
    const ringShape = this.createRingShape(1.12, 0.92)
    const ringGeometry = new ExtrudeGeometry(ringShape, {
      depth: 0.08,
      bevelEnabled: false,
    })
    const ringMaterial = new MeshStandardMaterial({
      color: PALETTE.selection,
      roughness: 0.6,
      metalness: 0.2,
      transparent: true,
      opacity: 0.8,
    })
    const ringMesh = new Mesh(ringGeometry, ringMaterial)
    ringMesh.rotation.x = -Math.PI / 2
    ringMesh.position.y = 0.25 // Above other hexes
    group.add(ringMesh)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)
    this.selectionRing = group
  }

  /**
   * Animate and update zoom-based label visibility
   * Optimized: skips work when camera hasn't changed and no workers are animating
   */
  animate(cameraDistance?: number, _cameraCenter?: { x: number; z: number }): void {
    // Scale labels and cards: only update when camera distance actually changed
    if (cameraDistance !== undefined && cameraDistance !== this.lastCameraDistance) {
      this.lastCameraDistance = cameraDistance

      const scaleThreshold = 7  // Below this: fixed size. Above: scale with map.
      const scale = cameraDistance <= scaleThreshold
        ? 1.0
        : scaleThreshold / cameraDistance  // Shrinks proportionally with zoom

      const cityFontSize = Math.round(28 * scale)   // City base: 28px
      const workerFontSize = Math.round(18 * scale) // Worker base: 18px

      // Only update DOM if font sizes actually changed
      if (cityFontSize !== this.lastFontSizes.city || workerFontSize !== this.lastFontSizes.worker) {
        this.lastFontSizes = { city: cityFontSize, worker: workerFontSize }

        for (const [, data] of this.hexMeshes) {
          if (data.type === 'city') {
            if (data.labelObject) {
              const label = data.labelObject.element as HTMLElement
              label.style.fontSize = `${cityFontSize}px`
            }
            data.workerLabels?.forEach(w => {
              const el = w.element as HTMLElement
              el.style.fontSize = `${workerFontSize}px`
            })
          }
        }
      }

      // Scale conversation cards with zoom
      for (const card of this.conversationCards.values()) {
        card.setScale(scale)
      }
    }

    // Worker breathing animation: only iterate if there are working workers
    if (this.workingWorkerIds.size === 0) return

    const now = Date.now()
    const period = 2500
    const t = (now % period) / period
    const breathScale = 1.0 + 0.03 * Math.sin(t * Math.PI * 2)

    // Only animate workers that are actually working
    for (const workerId of this.workingWorkerIds) {
      const data = this.hexMeshes.get(workerId)
      if (data?.mesh) {
        data.mesh.scale.setScalar(breathScale)
      }
    }
  }

  /**
   * Create activity ground decal showing recent tool calls
   * Returns a flat Mesh that lies on the hex surface
   */
  private createActivityDecal(activities: Activity[]): Mesh {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    const width = 256
    const height = 144  // 1.8x taller to fill hex
    const fontSize = 13

    canvas.width = width * 2
    canvas.height = height * 2
    ctx.scale(2, 2)

    // Semi-transparent dark background
    ctx.fillStyle = 'rgba(26, 24, 22, 0.7)'
    ctx.roundRect(0, 0, width, height, 4)
    ctx.fill()

    if (activities.length > 0) {
      const displayActivities = activities.slice(0, 3)  // Show 3 activities
      const lineHeight = 24
      const startY = 18
      const centerX = width / 2

      displayActivities.forEach((activity, i) => {
        const y = startY + i * lineHeight
        const opacity = 1 - i * 0.25  // Fade older entries

        // Build full text line
        let text = activity.tool
        if (activity.summary) {
          const summaryText = activity.summary.length > 18
            ? activity.summary.slice(0, 15) + '...'
            : activity.summary
          text += ` ${summaryText}`
        }

        // Draw centered
        ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`
        ctx.textAlign = 'center'
        ctx.fillStyle = `rgba(201, 162, 39, ${opacity})`
        ctx.fillText(text, centerX, y)
      })
    }

    const texture = new CanvasTexture(canvas)
    const worldWidth = 1.0
    const worldHeight = worldWidth * (height / width)  // Maintain aspect ratio
    const geometry = new PlaneGeometry(worldWidth, worldHeight)
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    })

    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2  // Lie flat
    mesh.rotation.z = Math.PI / 3   // 60° rotation
    return mesh
  }

  /**
   * Update activity display for a worker by tmux session
   */
  updateWorkerActivity(tmuxSession: string, activities: Activity[]): void {
    const workerData = Array.from(this.hexMeshes.values()).find(
      data => data.type === 'worker' && data.tmuxSession === tmuxSession && data.activityMesh
    )
    if (!workerData) return

    // Dispose old decal resources before removing
    this.disposeObject(workerData.activityMesh!)
    workerData.group.remove(workerData.activityMesh!)

    // Create new decal with updated activities
    const newMesh = this.createActivityDecal(activities)
    newMesh.position.y = this.hexHeight + 0.08  // Just above hex surface
    const activityOffset = this.hexToWorld(-0.023, -0.03)
    newMesh.position.x = activityOffset.x
    newMesh.position.z = activityOffset.z
    workerData.group.add(newMesh)
    workerData.activityMesh = newMesh
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
      hexes: this.hexMeshes.size
    }
    console.table(counts)
    return counts
  }

  // ═══════════════════════════════════════════════════════════
  // CONVERSATION CARDS - Map-pinned worker conversations
  // ═══════════════════════════════════════════════════════════

  /**
   * Set callback for file clicks in conversation cards
   */
  setCardFileClickHandler(handler: (fullPath: string, originId: string, workerId: string) => void): void {
    this.onCardFileClick = handler
  }

  /**
   * Open a conversation card for a worker
   * @param session The worker session to show conversation for
   * @returns The created card, or existing card if already open
   */
  openConversationCard(session: Session): ConversationCard | null {
    // Check if card already exists - bring to front if so
    const existing = this.conversationCards.get(session.id)
    if (existing) {
      this.bringCardToFront(session.id)
      return existing
    }

    // Find the worker's position in the scene
    const workerPos = this.getWorkerWorldPosition(session)
    if (!workerPos) {
      console.warn(`Cannot find position for worker ${session.id}`)
      return null
    }

    // Calculate offset: position card above and slightly away from worker
    // If worker is on the right side of the city, offset left (and vice versa)
    const city = session.cityId ? this.currentCities.get(session.cityId) : null
    let offsetX = 1.0  // Default: offset to the right
    if (city) {
      const cityPos = this.hexGrid.axialToCartesian(city.hex)
      offsetX = workerPos.x > cityPos.x ? -1.5 : 1.5  // Offset away from city center
    }

    // Load saved position if available
    const savedState = this.loadCardState(session.id)

    // Create card with saved or calculated offset
    const card = new ConversationCard(session, {
      onClose: () => this.closeConversationCard(session.id),
      onFileClick: this.onCardFileClick ?? undefined,
      onDoubleClick: () => {
        if (this.onWorkerDblClick) {
          this.onWorkerDblClick(session.id, session.tmuxSession)
        }
      },
      onBringToFront: () => this.bringCardToFront(session.id),
      initialOffset: savedState?.offset,
      initialSize: savedState?.size,
    })

    // Position the card above the worker with calculated offset
    card.object.position.set(workerPos.x + offsetX, 0.8, workerPos.z - 0.5)

    this.scene.add(card.object)
    this.conversationCards.set(session.id, card)

    // Set initial z-index
    this.topZIndex++
    card.setZIndex(this.topZIndex)

    // Apply current scale
    if (this.lastCameraDistance > 0) {
      const scale = this.calculateCardScale(this.lastCameraDistance)
      card.setScale(scale)
    }

    return card
  }

  /**
   * Bring a card to front (highest z-index)
   */
  private bringCardToFront(workerId: string): void {
    const card = this.conversationCards.get(workerId)
    if (!card) return

    this.topZIndex++
    card.setZIndex(this.topZIndex)
  }

  /**
   * Close a conversation card
   */
  closeConversationCard(workerId: string): void {
    const card = this.conversationCards.get(workerId)
    if (!card) return

    // Save card state before closing
    this.saveCardState(workerId, card)

    this.scene.remove(card.object)
    card.dispose()
    this.conversationCards.delete(workerId)
  }

  /**
   * Close all conversation cards
   */
  closeAllConversationCards(): void {
    for (const workerId of this.conversationCards.keys()) {
      this.closeConversationCard(workerId)
    }
  }

  /**
   * Check if a conversation card is open for a worker
   */
  hasConversationCard(workerId: string): boolean {
    return this.conversationCards.has(workerId)
  }

  /**
   * Handle WebSocket conversation update for cards
   */
  handleConversationMessage(tmuxSession: string, messages: ConversationMessage[]): void {
    for (const card of this.conversationCards.values()) {
      if (card.tmuxSession === tmuxSession) {
        card.handleMessage(tmuxSession, messages)
      }
    }
  }

  /**
   * Get world position of a worker (checks both city-attached and orphan workers)
   */
  private getWorkerWorldPosition(session: Session): { x: number; z: number } | null {
    // Check city workers
    for (const [, data] of this.hexMeshes) {
      if (data.type === 'city' && data.group) {
        // Search for ship mesh with this worker's ID
        let found: { x: number; z: number } | null = null
        data.group.traverse((child) => {
          if (child instanceof Mesh && child.userData?.workerId === session.id) {
            const cityPos = this.hexGrid.axialToCartesian(data.hex)
            found = {
              x: cityPos.x + child.position.x,
              z: cityPos.z + child.position.z,
            }
          }
        })
        if (found) return found
      }
    }

    // Check orphan workers (have their own hex position)
    if (session.hex) {
      const pos = this.hexGrid.axialToCartesian(session.hex)
      return { x: pos.x, z: pos.z }
    }

    return null
  }

  /**
   * Calculate card scale based on camera distance
   */
  private calculateCardScale(cameraDistance: number): number {
    const scaleThreshold = 7
    return cameraDistance <= scaleThreshold
      ? 1.0
      : scaleThreshold / cameraDistance
  }

  // ═══════════════════════════════════════════════════════════
  // CARD STATE PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  private readonly CARD_STATE_KEY = 'portolan-card-states'

  /**
   * Save card position and size to localStorage
   */
  private saveCardState(workerId: string, card: ConversationCard): void {
    try {
      const states = this.loadAllCardStates()
      states[workerId] = {
        offset: card.getOffset(),
        size: card.getSize(),
        timestamp: Date.now(),
      }

      // Clean up old entries (keep last 20)
      const entries = Object.entries(states)
      if (entries.length > 20) {
        entries.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0))
        const trimmed = Object.fromEntries(entries.slice(0, 20))
        localStorage.setItem(this.CARD_STATE_KEY, JSON.stringify(trimmed))
      } else {
        localStorage.setItem(this.CARD_STATE_KEY, JSON.stringify(states))
      }
    } catch {
      // Ignore localStorage errors
    }
  }

  /**
   * Load saved card state
   */
  private loadCardState(workerId: string): { offset: { x: number; y: number }; size?: { width: number; height: number } } | null {
    const states = this.loadAllCardStates()
    return states[workerId] || null
  }

  /**
   * Load all card states from localStorage
   */
  private loadAllCardStates(): Record<string, { offset: { x: number; y: number }; size?: { width: number; height: number }; timestamp?: number }> {
    try {
      const stored = localStorage.getItem(this.CARD_STATE_KEY)
      return stored ? JSON.parse(stored) : {}
    } catch {
      return {}
    }
  }

  /**
   * Dispose all resources (call before recreating during HMR)
   */
  dispose(): void {
    // Close all conversation cards
    this.closeAllConversationCards()

    // Remove and dispose all hex meshes
    for (const key of this.hexMeshes.keys()) {
      this.removeHex(key)
    }

    // Dispose scene objects
    const sceneObjects: Array<{ ref: Mesh | Group | null; clear: () => void }> = [
      { ref: this.groundPlane, clear: () => { this.groundPlane = null } },
      { ref: this.rhumbLinesGroup, clear: () => { this.rhumbLinesGroup = null } },
      { ref: this.selectionRing, clear: () => { this.selectionRing = null } },
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
    this.shipSprites.dispose()
  }
}
