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
import { createVellumPlane } from './VellumShader'
import { createRhumbLines, DEFAULT_RHUMB_PARAMS } from './RhumbRenderer'
import { createCoastline, DEFAULT_COASTLINE_PARAMS, type CoastlinePoint, type CityPosition, type CityCoastlinePosition } from './CoastlineRenderer'
import { HexGrid } from './HexGrid'
import { WorkerRenderer } from './WorkerRenderer'
import type { City, Session, HexCoord, Activity } from '../state/types'
import { PALETTE } from '../state/types'

interface HexMeshData {
  group: Group
  hex: HexCoord
  type: 'city' | 'empty'
  entityId?: string
  labelMesh?: Mesh  // For flat labels (cities)
}

export class ZoneRenderer {
  private scene: Scene
  private hexGrid: HexGrid
  private hexMeshes: Map<string, HexMeshData> = new Map()
  private groundPlane: Mesh | null = null
  private rhumbGroup: Group | null = null
  // Multiple coastlines - one per origin (island/continent)
  private coastlineGroups: Map<string, Group> = new Map()  // originId -> Group
  private coastlinePointsByOrigin: Map<string, CoastlinePoint[]> = new Map()  // originId -> points
  private cityCoastlinePositions: Map<string, CityCoastlinePosition> = new Map()  // cityId -> computed position
  private lastCityPositionHash: string = ''  // Track city positions for coastline regeneration
  private selectionRing: Group | null = null

  // Worker rendering delegated to WorkerRenderer
  private workerRenderer: WorkerRenderer

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.workerRenderer = new WorkerRenderer(scene, hexGrid)
    this.createGroundPlane()
    this.createRhumbLines()
    // Coastlines created per-origin in updateState when cities are available
    // Background hex grid removed — vellum + rhumb lines are the substrate now
  }

  private createGroundPlane(): void {
    // Portolan-style vellum ground plane with procedural shader
    // Large size for "infinite" feeling map - extends well beyond visible area
    const planeSize = 500  // World units - 10x larger for infinite feel

    // Create vellum plane with shader-based texture
    // Warm cream base with organic variation, edge darkening, corner wear
    this.groundPlane = createVellumPlane(planeSize, planeSize)
    this.groundPlane.position.y = -0.05  // Just below hex level
    this.scene.add(this.groundPlane)
  }

  private createRhumbLines(center?: { x: number; z: number }, clusterRadius?: number): void {
    // Remove existing rhumb group if present
    if (this.rhumbGroup) {
      this.scene.remove(this.rhumbGroup)
    }

    // Portolan-style rhumb lines radiating from compass roses
    // Balanced density - visible but not overwhelming
    this.rhumbGroup = createRhumbLines({
      ...DEFAULT_RHUMB_PARAMS,
      mapRadius: 250,
      primaryRoses: 1,           // Single primary rose
      secondaryRoses: 4,         // Few secondary roses (was 10)
      primaryDirections: 8,      // Fewer directions (was 16)
      secondaryDirections: 8,
      primaryOpacity: 0.25,      // Softer (was 0.32)
      secondaryOpacity: 0.15,    // Softer (was 0.18)
      center,
      clusterRadius: clusterRadius || 20,
    })
    this.rhumbGroup.position.y = -0.04  // Just above vellum, below hexes
    this.scene.add(this.rhumbGroup)
  }

  private createCoastlineForOrigin(originId: string, cityPositions: CityPosition[], seed: number): void {
    // Remove existing coastline for this origin if present
    const existingGroup = this.coastlineGroups.get(originId)
    if (existingGroup) {
      this.scene.remove(existingGroup)
    }

    // Need at least 3 cities to form a closed coastline
    if (cityPositions.length < 3) {
      this.coastlineGroups.delete(originId)
      this.coastlinePointsByOrigin.delete(originId)
      return
    }

    // Portolan-style coastline with hatching (comb teeth)
    // Each origin forms its own island/continent
    const result = createCoastline({
      ...DEFAULT_COASTLINE_PARAMS,
      seed,  // Different seed per origin for variety
      mapRadius: 250,  // Large radius for infinite map feel
      hatchDensity: Math.max(20, cityPositions.length * 8),  // Less frequent
      hatchLength: 0.35,          // Shorter hatches
      hatchOpacity: 0.65,         // Visible but not overwhelming
      hatchWidth: 1.5,            // Thinner hatching strokes
      coastlineOpacity: 0.9,      // Strong coastline stroke
      coastlineWidth: 2.5,        // Thicker coastline
      cityPositions,
    })
    if (result && result.group) {
      this.coastlineGroups.set(originId, result.group)
      this.coastlinePointsByOrigin.set(originId, result.points)
      result.group.position.y = -0.02  // Above rhumb lines, below hexes
      this.scene.add(result.group)

      // Store computed city positions for use in renderCity
      for (const cityPos of result.cityPositions) {
        this.cityCoastlinePositions.set(cityPos.id, cityPos)
      }
    }
  }

  private clearAllCoastlines(): void {
    for (const group of this.coastlineGroups.values()) {
      this.scene.remove(group)
    }
    this.coastlineGroups.clear()
    this.coastlinePointsByOrigin.clear()
  }

  /**
   * Create port-style label for cities (perpendicular to coastline)
   * Simple text on transparent background, manuscript red
   */
  private createPortLabel(
    text: string,
    fontSize = 36,
    color: string = '#A0171B'  // Bright manuscript red
  ): { texture: CanvasTexture; width: number; height: number } {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    // Measure text
    ctx.font = `600 ${fontSize}px 'EB Garamond', Garamond, serif`
    const metrics = ctx.measureText(text)
    const textWidth = metrics.width

    const padding = fontSize * 0.3
    const width = textWidth + padding * 2
    const height = fontSize * 1.4

    // High-res canvas
    const scale = 2
    canvas.width = width * scale
    canvas.height = height * scale
    ctx.scale(scale, scale)

    // Transparent background
    ctx.clearRect(0, 0, width, height)

    // Draw text centered
    ctx.font = `600 ${fontSize}px 'EB Garamond', Garamond, serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const cx = width / 2
    const cy = height / 2

    // Subtle shadow for legibility on vellum
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
    ctx.fillText(text, cx + 1, cy + 1)

    // Main text - bright manuscript red
    ctx.fillStyle = color
    ctx.fillText(text, cx, cy)

    return {
      texture: new CanvasTexture(canvas),
      width,
      height,
    }
  }


  renderCity(city: City): void {
    const key = this.hexGrid.hexKey(city.hex)

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()

    // Use coastline-computed position if available, otherwise fall back to hex position
    const coastlinePos = this.cityCoastlinePositions.get(city.id)
    const pos = coastlinePos
      ? { x: coastlinePos.x, z: coastlinePos.z }
      : this.hexGrid.axialToCartesian(city.hex)

    // The label IS the city - no separate marker, no offset
    const label = this.createPortLabel(city.name, 42, '#A0171B')  // Bright manuscript red
    const labelMesh = new Mesh(
      new PlaneGeometry(label.width * 0.014, label.height * 0.014),
      new MeshBasicMaterial({
        map: label.texture,
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
      })
    )
    labelMesh.rotation.x = -Math.PI / 2  // Lie flat on ground
    labelMesh.position.y = 0.03

    // Apply rotation to point inland (perpendicular to coastline)
    if (coastlinePos) {
      // tangentAngle is already the inland-pointing perpendicular angle
      labelMesh.rotation.z = coastlinePos.tangentAngle
    }

    group.add(labelMesh)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, {
      group, hex: city.hex, type: 'city', entityId: city.id,
      labelMesh,
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

    // Group cities by origin for separate coastlines (islands/continents)
    const citiesByOrigin = new Map<string, City[]>()
    for (const city of cities) {
      const originCities = citiesByOrigin.get(city.originId) || []
      originCities.push(city)
      citiesByOrigin.set(city.originId, originCities)
    }

    // Create position hash including origin grouping
    const positionHash = cities.map(c => {
      const pos = this.hexGrid.axialToCartesian(c.hex)
      return `${c.originId}:${c.id}:${pos.x.toFixed(2)}:${pos.z.toFixed(2)}`
    }).sort().join('|')

    // Regenerate coastlines and rhumb lines if cities changed
    if (positionHash !== this.lastCityPositionHash) {
      this.lastCityPositionHash = positionHash
      this.clearAllCoastlines()

      // Calculate city cluster centroid and extent for rhumb line positioning
      if (cities.length > 0) {
        let sumX = 0, sumZ = 0
        let minX = Infinity, maxX = -Infinity
        let minZ = Infinity, maxZ = -Infinity

        for (const city of cities) {
          const pos = this.hexGrid.axialToCartesian(city.hex)
          sumX += pos.x
          sumZ += pos.z
          minX = Math.min(minX, pos.x)
          maxX = Math.max(maxX, pos.x)
          minZ = Math.min(minZ, pos.z)
          maxZ = Math.max(maxZ, pos.z)
        }

        const center = { x: sumX / cities.length, z: sumZ / cities.length }
        // Cluster radius based on city spread, with minimum for small clusters
        const extentX = maxX - minX
        const extentZ = maxZ - minZ
        const clusterRadius = Math.max(15, Math.max(extentX, extentZ) * 0.8)

        // Regenerate rhumb lines centered on city cluster
        this.createRhumbLines(center, clusterRadius)
      }

      // Create one coastline per origin (each origin is an island/continent)
      let seedOffset = 0
      for (const [originId, originCities] of citiesByOrigin) {
        const cityPositions: CityPosition[] = originCities.map(city => {
          const pos = this.hexGrid.axialToCartesian(city.hex)
          return { id: city.id, name: city.name, x: pos.x, z: pos.z }
        })
        // Different seed per origin for visual variety
        this.createCoastlineForOrigin(originId, cityPositions, 42 + seedOffset * 1000)
        seedOffset++
      }
    }

    // Render cities
    for (const city of cities) {
      const key = this.hexGrid.hexKey(city.hex)
      expectedKeys.add(key)
      this.renderCity(city)
    }

    // Pass coastline city positions to WorkerRenderer
    const workerCityPositions = new Map<string, { x: number; z: number }>()
    for (const [cityId, pos] of this.cityCoastlinePositions) {
      workerCityPositions.set(cityId, { x: pos.x, z: pos.z })
    }
    this.workerRenderer.setCityCoastlinePositions(workerCityPositions)

    // Delegate worker rendering to WorkerRenderer
    this.workerRenderer.updateWorkers(sessions, cities)

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
   * Find entity at a hex position (cities only, workers now use getWorkerAtPosition)
   */
  getEntityAtHex(hex: HexCoord): { type: 'city' | 'empty'; entityId?: string } | null {
    const key = this.hexGrid.hexKey(hex)
    const data = this.hexMeshes.get(key)
    if (data) {
      return { type: data.type, entityId: data.entityId }
    }
    return null
  }

  /**
   * Find worker at world position (workers wander, so use world coords not hex)
   */
  getWorkerAtPosition(x: number, z: number): { type: 'worker'; entityId: string; entityName: string } | null {
    const worker = this.workerRenderer.getWorkerAtPosition(x, z)
    if (worker) {
      return { type: 'worker', entityId: worker.id, entityName: worker.name }
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
   * Animate workers (force simulation + footprint fading)
   * Call every frame with delta time
   */
  animate(deltaTime: number): void {
    // Worker simulation and animation delegated to WorkerRenderer
    this.workerRenderer.simulate(deltaTime)
    this.workerRenderer.animate(deltaTime)
  }

  /**
   * Update activity display for a worker by tmux session
   */
  updateWorkerActivity(tmuxSession: string, activities: Activity[]): void {
    this.workerRenderer.updateActivity(tmuxSession, activities)
  }

  /**
   * Update label scales based on camera distance for zoom-stable text
   * Labels stay readable at all zoom levels (within min/max bounds)
   * @param cameraDistance - Distance from camera to ground plane
   */
  updateLabelScales(cameraDistance: number): void {
    // Reference distance where labels are at "natural" size (base scale = 1.0)
    const referenceDistance = 20
    const minScale = 0.6  // Minimum scale (when zoomed in very close)
    const maxScale = 3.0  // Maximum scale (when zoomed far out)

    // Scale PROPORTIONALLY with camera distance to compensate for perspective
    // When zoomed out (larger distance), labels need to be bigger
    let scale = cameraDistance / referenceDistance

    // Clamp to min/max bounds
    scale = Math.max(minScale, Math.min(maxScale, scale))

    // Update city labels
    for (const data of this.hexMeshes.values()) {
      if (data.labelMesh) {
        data.labelMesh.scale.setScalar(scale)
      }
    }

    // Update worker labels
    this.workerRenderer.updateLabelScales(cameraDistance, minScale, maxScale)
  }
}
