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
  Line,
} from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { HexGrid } from './HexGrid'
import { createVellumPlane } from './VellumShader'
import { createRhumbLines } from './RhumbLines'
import { CitySpritesManager } from './CitySpritesManager'
import { ShipSpritesManager } from './ShipSpritesManager'
import type { City, Session, HexCoord } from '../state/types'
import { PALETTE } from '../state/types'

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

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.citySprites = new CitySpritesManager()
    this.shipSprites = new ShipSpritesManager()
    this.createGroundPlane()
    // No background hex grid - spec says "just the vellum surface"
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
   */
  private disposeObject(obj: Object3D): void {
    obj.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry?.dispose()
        if (child.material instanceof Material) {
          child.material.dispose()
          if ('map' in child.material) (child.material as MeshBasicMaterial).map?.dispose()
        } else if (Array.isArray(child.material)) {
          child.material.forEach(m => {
            m.dispose()
            if ('map' in m) (m as MeshBasicMaterial).map?.dispose()
          })
        }
      }
      if (child instanceof LineLoop || child instanceof Line) {
        child.geometry?.dispose()
        ;(child.material as Material)?.dispose()
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
    if (data) {
      // Clean up CSS2D label DOM elements
      if (data.labelObject) {
        data.labelObject.element.remove()
      }
      if (data.workerLabels) {
        for (const label of data.workerLabels) {
          label.element.remove()
        }
      }
      // Dispose Three.js resources before removing from scene
      this.disposeObject(data.group)
      this.scene.remove(data.group)
      this.hexMeshes.delete(key)
    }
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
    // Remove existing selection ring
    if (this.selectionRing) {
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
   */
  animate(cameraDistance?: number, _cameraCenter?: { x: number; z: number }): void {
    // Scale labels: fixed size when close, then scale with map when zoomed out
    if (cameraDistance !== undefined) {
      const scaleThreshold = 7  // Below this: fixed size. Above: scale with map.
      const scale = cameraDistance <= scaleThreshold
        ? 1.0
        : scaleThreshold / cameraDistance  // Shrinks proportionally with zoom

      const cityFontSize = Math.round(28 * scale)   // City base: 28px
      const workerFontSize = Math.round(18 * scale) // Worker base: 18px

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

    // Worker breathing animation
    const now = Date.now()
    const period = 2500

    for (const [, data] of this.hexMeshes) {
      if (data.type === 'worker' && data.mesh) {
        if (data.status === 'working') {
          const t = (now % period) / period
          const scale = 1.0 + 0.03 * Math.sin(t * Math.PI * 2)
          data.mesh.scale.setScalar(scale)
        } else {
          data.mesh.scale.setScalar(1.0)
        }
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
    for (const [, data] of this.hexMeshes) {
      if (data.type === 'worker' && data.tmuxSession === tmuxSession && data.activityMesh) {
        // Dispose old decal resources before removing
        this.disposeObject(data.activityMesh)
        data.group.remove(data.activityMesh)

        // Create new decal with updated activities
        const newMesh = this.createActivityDecal(activities)
        newMesh.position.y = this.hexHeight + 0.08  // Just above hex surface
        const activityOffset = this.hexToWorld(-0.023, -0.03)
        newMesh.position.x = activityOffset.x
        newMesh.position.z = activityOffset.z
        data.group.add(newMesh)
        data.activityMesh = newMesh
        break
      }
    }
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
}
