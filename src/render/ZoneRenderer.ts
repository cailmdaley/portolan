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
} from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { HexGrid } from './HexGrid'
import { createVellumPlane } from './VellumShader'
import { CitySpritesManager } from './CitySpritesManager'
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
}

export class ZoneRenderer {
  private scene: Scene
  private hexGrid: HexGrid
  private hexMeshes: Map<string, HexMeshData> = new Map()
  private groundPlane: Mesh | null = null
  private selectionRing: Group | null = null

  // Hex geometry settings
  private readonly hexHeight = 0.15

  // City sprites manager (nano-banana generated city plans)
  private citySprites: CitySpritesManager

  // Camera rotation (45° = π/4) - must match Camera.ts
  private readonly cameraRotation = Math.PI / 4

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.citySprites = new CitySpritesManager()
    this.createGroundPlane()
    // No background hex grid - spec says "just the vellum surface"
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

  private createGroundPlane(): void {
    // Vellum background - aged parchment with procedural shader
    // Size to roughly match hex grid (radius 30 hexes, hexRadius 1.0)
    // Hex spacing is ~1.73 (sqrt(3)), so radius 30 ≈ 52 units
    const planeSize = 60  // World units (slightly larger for edge effects)

    this.groundPlane = createVellumPlane(planeSize, planeSize)
    this.groundPlane.position.y = -0.05  // Just below hex level
    this.scene.add(this.groundPlane)
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

  renderCity(city: City, workers: Session[] = []): void {
    const key = this.hexGrid.hexKey(city.hex)

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(city.hex)

    // City sprite - nano-banana generated city plan, lying flat on vellum
    const texture = this.citySprites.getSprite(city)

    if (texture) {
      // Use a flat plane mesh instead of billboard sprite
      const spriteSize = 3.5  // World units diameter
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

    // City label - CSS2D HTML element for proper small caps
    const labelDiv = document.createElement('div')
    labelDiv.className = 'city-label'
    labelDiv.textContent = city.name
    const labelObject = new CSS2DObject(labelDiv)
    labelObject.position.y = 2.0  // Above the sprite
    group.add(labelObject)

    // Worker labels - clustered on the city sprite
    // Position workers in a ring around center, angled toward city label
    const workerLabels: CSS2DObject[] = []
    const workerCount = workers.length
    if (workerCount > 0) {
      const baseRadius = 0.8  // Distance from center
      const startAngle = Math.PI  // Start at bottom (opposite label)
      const angleSpread = Math.PI * 0.8  // Spread across ~140°

      workers.forEach((worker, i) => {
        const angle = workerCount === 1
          ? startAngle  // Single worker at bottom
          : startAngle - angleSpread/2 + (angleSpread * i / (workerCount - 1))

        const workerDiv = document.createElement('div')
        workerDiv.className = worker.status === 'working' ? 'worker-label working' : 'worker-label'
        workerDiv.textContent = worker.name
        workerDiv.dataset.workerId = worker.id
        workerDiv.dataset.tmuxSession = worker.tmuxSession

        const workerLabelObj = new CSS2DObject(workerDiv)
        // Position on the sprite plane (y = height, x/z from angle)
        workerLabelObj.position.set(
          Math.cos(angle) * baseRadius,
          0.5,  // Just above sprite surface
          Math.sin(angle) * baseRadius
        )
        group.add(workerLabelObj)
        workerLabels.push(workerLabelObj)
      })
    }

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, {
      group, hex: city.hex, type: 'city', entityId: city.id,
      labelObject, workerLabels
    })
  }

  /**
   * Render an orphan worker (no city) as a small marker
   * These are workers that exist but aren't associated with any city
   */
  renderOrphanWorker(session: Session): void {
    if (!session.hex) return

    const key = this.hexGrid.hexKey(session.hex)

    // Check if worker already exists - just update status
    const existing = this.hexMeshes.get(key)
    if (existing && existing.type === 'worker' && existing.entityId === session.id) {
      if (existing.status !== session.status && existing.mesh) {
        const color = session.status === 'working' ? PALETTE.workerActive : PALETTE.workerIdle
        ;(existing.mesh.material as MeshStandardMaterial).color.setHex(color)
        existing.status = session.status
      }
      return
    }

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(session.hex)

    // Small marker for orphan workers
    const color = session.status === 'working' ? PALETTE.workerActive : PALETTE.workerIdle
    const markerMesh = this.createHexMesh(color, 0.3, 0.05)
    group.add(markerMesh)

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
      mesh: markerMesh,
      status: session.status,
      labelObject,
    })
  }

  private removeHex(key: string): void {
    const data = this.hexMeshes.get(key)
    if (data) {
      this.scene.remove(data.group)
      this.hexMeshes.delete(key)
    }
  }

  updateState(cities: City[], sessions: Session[]): void {
    // Track what should exist
    const expectedKeys = new Set<string>()

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

    // Render cities with their workers
    for (const city of cities) {
      const key = this.hexGrid.hexKey(city.hex)
      expectedKeys.add(key)
      const cityWorkers = workersByCity.get(city.id) || []
      this.renderCity(city, cityWorkers)
    }

    // Render orphan workers (no city) as small markers
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
   * Animate worker hexes (breathing pulse)
   * CSS2D labels maintain constant screen size automatically
   */
  animate(_cameraDistance?: number): void {
    const now = Date.now()
    const period = 2500 // 2.5 second breathing cycle

    for (const [, data] of this.hexMeshes) {
      if (data.type === 'worker' && data.mesh) {
        if (data.status === 'working') {
          // Breathing pulse: scale oscillates 1.0 → 1.03 → 1.0
          const t = (now % period) / period
          const scale = 1.0 + 0.03 * Math.sin(t * Math.PI * 2)
          data.mesh.scale.setScalar(scale)
        } else {
          // Ensure idle workers are at base scale
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
        // Remove old decal
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
}
