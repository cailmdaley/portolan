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
  Sprite,
  SpriteMaterial,
  TextureLoader,
} from 'three'
import { HexGrid } from './HexGrid'
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
  labelSprite?: Sprite  // For screen-space scaling (cities only)
  labelMesh?: Mesh  // For flat labels (workers)
  baseScale?: number  // Base scale for label
}

export class ZoneRenderer {
  private scene: Scene
  private hexGrid: HexGrid
  private hexMeshes: Map<string, HexMeshData> = new Map()
  private groundPlane: Mesh | null = null
  private selectionRing: Group | null = null

  // Hex geometry settings
  private readonly hexHeight = 0.15
  private readonly workerScale = 0.6

  // Banner image for city labels (loaded async)
  private cityBannerImage: HTMLImageElement | null = null

  // Camera rotation (45° = π/4) - must match Camera.ts
  private readonly cameraRotation = Math.PI / 4

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.loadBannerImage()
    this.createGroundPlane()
    this.createBackgroundHexes()
  }

  /**
   * Convert screen-relative offset to world XZ coordinates.
   * Screen coordinates: +X = right, +Y = up (toward back of scene)
   * Accounts for 45° camera rotation.
   */
  private screenToWorld(screenX: number, screenY: number): { x: number; z: number } {
    const cos = Math.cos(this.cameraRotation)
    const sin = Math.sin(this.cameraRotation)
    // Screen-right in world = (cos, 0, -sin) = (0.707, 0, -0.707)
    // Screen-up in world = (-sin, 0, -cos) = (-0.707, 0, -0.707)
    return {
      x: screenX * cos - screenY * sin,
      z: -screenX * sin - screenY * cos,
    }
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

  private loadBannerImage(): void {
    // Load city banner (parchment)
    const cityImg = new Image()
    cityImg.onload = () => {
      this.cityBannerImage = cityImg
    }
    cityImg.src = '/banner.png'
  }

  private createGroundPlane(): void {
    // Terrain texture plane - photorealistic aerial view
    // Size to roughly match hex grid (radius 30 hexes, hexRadius 1.0)
    // Hex spacing is ~1.73 (sqrt(3)), so radius 30 ≈ 52 units
    // Image is square (1:1 aspect ratio)
    const planeSize = 50  // World units

    const geometry = new PlaneGeometry(planeSize, planeSize)
    const material = new MeshStandardMaterial({
      color: 0xffffff,  // White to show texture true colors
      roughness: 0.9,
      metalness: 0,
      side: DoubleSide,
    })

    // Load terrain texture
    const textureLoader = new TextureLoader()
    textureLoader.load('/terrain.png', (texture) => {
      material.map = texture
      material.needsUpdate = true
    })

    this.groundPlane = new Mesh(geometry, material)
    this.groundPlane.rotation.x = -Math.PI / 2
    this.groundPlane.position.y = -0.05  // Just below hex level
    this.groundPlane.receiveShadow = true
    this.scene.add(this.groundPlane)
  }

  private createBackgroundHexes(): void {
    // Create a subtle grid of empty hexes for context
    const radius = Math.min(this.hexGrid.size, 30)
    const hexes = this.hexGrid.getHexesInRadius({ q: 0, r: 0 }, radius)

    for (const hex of hexes) {
      this.createEmptyHex(hex)
    }
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
   * Create hex edge outline for visual definition
   */
  private createHexEdge(scale = 1): LineLoop {
    const r = this.hexGrid.hexRadius * scale
    const points: Vector3[] = []

    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      points.push(new Vector3(r * Math.cos(angle), 0, r * Math.sin(angle)))
    }

    const geometry = new BufferGeometry().setFromPoints(points)
    const material = new LineBasicMaterial({
      color: 0x000000,  // Black lines
      transparent: true,
      opacity: 0.12,    // Very subtle
    })

    return new LineLoop(geometry, material)
  }

  private createEmptyHex(hex: HexCoord): void {
    const key = this.hexGrid.hexKey(hex)
    if (this.hexMeshes.has(key)) return

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(hex)

    // Just edge line - no filled hex, so terrain shows through
    const edge = this.createHexEdge(0.98)
    edge.position.y = 0.01
    group.add(edge)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, { group, hex, type: 'empty' })
  }

  private createLabel(
    text: string,
    fontSize = 48,
    color: string = '#4A1515',
    bannerImage: HTMLImageElement | null = null,
    sliceWidth = 40  // Size of left/right caps (larger = more decorative edges)
  ): { texture: CanvasTexture; width: number; height: number } {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    // Measure text first to determine banner width
    ctx.font = `600 ${fontSize}px 'EB Garamond', Garamond, serif`
    const metrics = ctx.measureText(text)
    const textWidth = metrics.width

    // Banner source dimensions (from the PNG)
    const srcW = 1408
    const srcH = 768
    const leftSlice = sliceWidth
    const rightSlice = sliceWidth
    const middleSrcW = srcW - leftSlice - rightSlice

    // Calculate output dimensions based on text width
    const hPadding = fontSize * 0.3  // Horizontal padding
    const vPadding = fontSize * 0.5   // Vertical padding (taller)
    const minMiddleW = 20
    const middleW = Math.max(textWidth + hPadding, minMiddleW)
    const outW = leftSlice + middleW + rightSlice
    const outH = fontSize + vPadding * 2  // Height based on font size, not source image

    // Set canvas size (high res)
    const scale = 1.5
    canvas.width = outW * scale
    canvas.height = outH * scale
    ctx.scale(scale, scale)

    // If banner image is loaded, use 3-slice compositing
    if (bannerImage) {
      // Left slice (fixed)
      ctx.drawImage(
        bannerImage,
        0, 0, leftSlice, srcH,           // source
        0, 0, leftSlice, outH             // dest
      )

      // Middle slice (stretched)
      ctx.drawImage(
        bannerImage,
        leftSlice, 0, middleSrcW, srcH,   // source
        leftSlice, 0, middleW, outH       // dest (stretched)
      )

      // Right slice (fixed)
      ctx.drawImage(
        bannerImage,
        srcW - rightSlice, 0, rightSlice, srcH,  // source
        leftSlice + middleW, 0, rightSlice, outH  // dest
      )

    } else {
      // Fallback: simple parchment rectangle if image not loaded
      ctx.fillStyle = '#EDE4D6'
      ctx.fillRect(0, 0, outW, outH)
      ctx.strokeStyle = '#8B7355'
      ctx.lineWidth = 3
      ctx.strokeRect(2, 2, outW - 4, outH - 4)
    }

    // Draw text centered
    const cx = outW / 2
    const cy = outH / 2

    ctx.font = `600 ${fontSize}px 'EB Garamond', Garamond, serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // Text shadow
    ctx.fillStyle = 'rgba(30, 20, 15, 0.2)'
    ctx.fillText(text, cx + 2, cy + 3)

    // Main text - deep blood red
    ctx.fillStyle = color
    ctx.fillText(text, cx, cy)

    return {
      texture: new CanvasTexture(canvas),
      width: outW,
      height: outH
    }
  }

  /**
   * Create flat text label (no banner) for workers
   * Returns a Mesh that lies flat on the hex surface
   * Font size is constant; mesh width scales with text length
   * Long text is truncated with ellipsis to maxChars (default 20)
   */
  private createFlatLabel(
    text: string,
    fontSize = 32,
    _color: string = '#3D2817',  // Reserved for future use
    maxChars = 20
  ): Mesh {
    // Truncate long labels (no ellipsis - just cut)
    const displayText = text.length > maxChars
      ? text.slice(0, maxChars)
      : text

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    // Measure text
    ctx.font = `600 ${fontSize}px 'EB Garamond', Garamond, serif`
    const metrics = ctx.measureText(displayText)
    const textWidth = metrics.width

    const padding = fontSize * 0.3
    const width = textWidth + padding * 2
    const height = fontSize + padding

    // High-res canvas
    const scale = 2
    canvas.width = width * scale
    canvas.height = height * scale
    ctx.scale(scale, scale)

    // Transparent background
    ctx.clearRect(0, 0, width, height)

    // Draw text with subtle shadow for legibility
    ctx.font = `600 ${fontSize}px 'EB Garamond', Garamond, serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const cx = width / 2
    const cy = height / 2

    // Dark shadow for contrast
    ctx.fillStyle = 'rgba(30, 25, 20, 0.8)'
    ctx.fillText(displayText, cx + 1.5, cy + 1.5)

    // Main text - cream/off-white for visibility
    ctx.fillStyle = '#F5F0E8'
    ctx.fillText(displayText, cx, cy)

    const texture = new CanvasTexture(canvas)
    // Scale world size based on font size
    const worldHeight = fontSize * 0.004  // Scale with font size
    const aspectRatio = width / height
    const geometry = new PlaneGeometry(worldHeight * aspectRatio, worldHeight)
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    })

    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2  // Lie flat
    mesh.rotation.z = Math.PI / 3   // 60° rotation (match activity)
    return mesh
  }

  renderCity(city: City): void {
    const key = this.hexGrid.hexKey(city.hex)

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(city.hex)

    // City hex - gold (active) or muted (dormant, no workers)
    const hexColor = city.isDormant ? PALETTE.cityDormant : PALETTE.cityHex
    const cityMesh = this.createHexMesh(hexColor, 1, this.hexHeight * 1.5)
    group.add(cityMesh)

    // Border hex
    const borderMesh = this.createHexMesh(PALETTE.border, 1.02, 0.02)
    borderMesh.position.y = -0.01
    group.add(borderMesh)

    // Label (city name) - billboard sprite, floats above hex
    const label = this.createLabel(city.name, 240, '#4A1515', this.cityBannerImage)
    const labelMaterial = new SpriteMaterial({
      map: label.texture,
      transparent: true,
      rotation: 0,  // Keep horizontal
    })
    const labelSprite = new Sprite(labelMaterial)
    const aspectRatio = label.width / label.height
    const baseScale = 1.2  // Base height in world units for cities
    labelSprite.scale.set(baseScale * aspectRatio, baseScale, 1)
    labelSprite.position.y = this.hexHeight * 1.5 + 1.0
    group.add(labelSprite)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, {
      group, hex: city.hex, type: 'city', entityId: city.id,
      labelSprite, baseScale
    })
  }

  renderWorker(session: Session): void {
    if (!session.hex) return

    const key = this.hexGrid.hexKey(session.hex)

    // Check if worker already exists - just update status color, preserve activity
    const existing = this.hexMeshes.get(key)
    if (existing && existing.type === 'worker' && existing.entityId === session.id) {
      // Update color if status changed
      if (existing.status !== session.status && existing.mesh) {
        const color = session.status === 'working' ? PALETTE.workerActive : PALETTE.workerIdle
        ;(existing.mesh.material as MeshStandardMaterial).color.setHex(color)
        existing.status = session.status
      }
      return  // Don't recreate - preserve activity mesh
    }

    // Remove existing mesh at this position (different entity)
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(session.hex)

    // Choose color based on status
    const color = session.status === 'working' ? PALETTE.workerActive : PALETTE.workerIdle

    // Worker hex - smaller, positioned around city
    const workerMesh = this.createHexMesh(color, this.workerScale)
    group.add(workerMesh)

    // Worker label - on hex face (screen-relative: +X=right, +Y=up)
    // Position based on name hash + hex position for unique offsets
    const labelMesh = this.createFlatLabel(session.name, 200, '#3D2817')
    const nameHash = session.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
    // Combine name hash with hex position for better spread
    const combined = nameHash + session.hex.q * 7 + session.hex.r * 13
    const xVar = ((combined % 7) - 3) * 0.05  // -0.15 to +0.15
    const yVar = ((combined % 4)) * 0.012     // 0 to 0.036
    labelMesh.position.y = this.hexHeight + 0.025 + yVar
    const labelOffset = this.screenToWorld(-0.12 + xVar, 0.5)
    labelMesh.position.x = labelOffset.x
    labelMesh.position.z = labelOffset.z
    group.add(labelMesh)

    // Activity decal - on hex face (hex-aligned: +X=right, +Y=up along 60° axis)
    const activityMesh = this.createActivityDecal([])
    activityMesh.position.y = this.hexHeight + 0.08  // Just above hex surface
    const activityOffset = this.hexToWorld(-0.023, -0.03)
    activityMesh.position.x = activityOffset.x
    activityMesh.position.z = activityOffset.z
    group.add(activityMesh)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, {
      group,
      hex: session.hex,
      type: 'worker',
      entityId: session.id,
      entityName: session.name,  // Store name for tooltip
      tmuxSession: session.tmuxSession,
      mesh: workerMesh,
      status: session.status,
      activityMesh,
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

    // Render cities
    for (const city of cities) {
      const key = this.hexGrid.hexKey(city.hex)
      expectedKeys.add(key)
      this.renderCity(city)
    }

    // Render workers
    for (const session of sessions) {
      if (session.hex) {
        const key = this.hexGrid.hexKey(session.hex)
        expectedKeys.add(key)
        this.renderWorker(session)
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
   * Animate worker hexes and scale city labels for screen-space sizing
   * Worker labels are flat and scale naturally with zoom
   */
  animate(cameraDistance?: number): void {
    const now = Date.now()
    const period = 2500 // 2.5 second breathing cycle

    // Scale factor for city labels - keeps them constant screen size
    // At distance 10, scale = 1.0; at distance 20, scale = 2.0, etc.
    const labelScaleFactor = cameraDistance ? cameraDistance / 10 : 1

    for (const [, data] of this.hexMeshes) {
      // Scale city labels to maintain screen size (workers use flat labels)
      if (data.labelSprite && data.baseScale) {
        const aspectRatio = data.labelSprite.scale.x / data.labelSprite.scale.y
        const scaledHeight = data.baseScale * labelScaleFactor * 0.5  // 0.5 = smaller labels
        data.labelSprite.scale.set(scaledHeight * aspectRatio, scaledHeight, 1)
      }

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
