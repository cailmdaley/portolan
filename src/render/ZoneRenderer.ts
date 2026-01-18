// ZoneRenderer.ts - Renders hexes with Cartographic Warmth styling

import {
  Scene,
  Mesh,
  MeshStandardMaterial,
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
} from 'three'
import { HexGrid } from './HexGrid'
import type { City, Session, HexCoord } from '../state/types'
import { PALETTE, PALETTE_CSS } from '../state/types'

interface HexMeshData {
  group: Group
  hex: HexCoord
  type: 'city' | 'worker' | 'empty'
  entityId?: string
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

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.createGroundPlane()
    this.createBackgroundHexes()
  }

  private createGroundPlane(): void {
    // Paper/parchment texture plane
    const geometry = new PlaneGeometry(500, 500)
    const material = new MeshStandardMaterial({
      color: PALETTE.sand,
      roughness: 0.9,
      metalness: 0,
      side: DoubleSide,
    })

    this.groundPlane = new Mesh(geometry, material)
    this.groundPlane.rotation.x = -Math.PI / 2
    this.groundPlane.position.y = -0.1
    this.groundPlane.receiveShadow = true
    this.scene.add(this.groundPlane)
  }

  private createBackgroundHexes(): void {
    // Create a subtle grid of empty hexes for context
    const radius = Math.min(this.hexGrid.size, 8)
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
      color: PALETTE.umber,
      transparent: true,
      opacity: 0.3,
    })

    return new LineLoop(geometry, material)
  }

  private createEmptyHex(hex: HexCoord): void {
    const key = this.hexGrid.hexKey(hex)
    if (this.hexMeshes.has(key)) return

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(hex)

    // Random subtle elevation for terrain feel
    const elevation = Math.random() * 0.04

    // Subtle hex for background grid (sand = idle per spec)
    const hexMesh = this.createHexMesh(PALETTE.sand, 0.98, 0.02)
    hexMesh.position.y = 0.01 + elevation
    group.add(hexMesh)

    // Edge line for definition
    const edge = this.createHexEdge(0.98)
    edge.position.y = 0.03 + elevation
    group.add(edge)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, { group, hex, type: 'empty' })
  }

  private createLabel(text: string, fontSize = 48, color: string = PALETTE_CSS.vermillion): CanvasTexture {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    canvas.width = 512
    canvas.height = 128

    ctx.fillStyle = 'transparent'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Draw text with outline for better contrast
    ctx.font = `700 ${fontSize}px 'Crimson Pro', serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // White outline for contrast
    ctx.strokeStyle = 'rgba(232, 220, 196, 0.9)'
    ctx.lineWidth = 4
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2)

    // Main text
    ctx.fillStyle = color
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)

    return new CanvasTexture(canvas)
  }

  renderCity(city: City): void {
    const key = this.hexGrid.hexKey(city.hex)

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(city.hex)

    // City hex - ochre with slight elevation
    const cityMesh = this.createHexMesh(PALETTE.ochre, 1, this.hexHeight * 1.5)
    group.add(cityMesh)

    // Border hex
    const borderMesh = this.createHexMesh(PALETTE.umber, 1.02, 0.02)
    borderMesh.position.y = -0.01
    group.add(borderMesh)

    // Label (city name) - vermillion for navigation
    const labelTexture = this.createLabel(city.name, 48, PALETTE_CSS.vermillion)
    const labelGeometry = new PlaneGeometry(4, 1)
    const labelMaterial = new MeshStandardMaterial({
      map: labelTexture,
      transparent: true,
      roughness: 1,
      metalness: 0,
    })
    const labelMesh = new Mesh(labelGeometry, labelMaterial)
    labelMesh.rotation.x = -Math.PI / 2
    labelMesh.position.y = this.hexHeight * 1.5 + 0.1
    group.add(labelMesh)

    // Fiber count badge - umber for contrast
    if (city.fiberCount > 0) {
      const badgeTexture = this.createLabel(`${city.fiberCount}`, 36, PALETTE_CSS.umber)
      const badgeGeometry = new PlaneGeometry(0.8, 0.5)
      const badgeMaterial = new MeshStandardMaterial({
        map: badgeTexture,
        transparent: true,
        roughness: 1,
        metalness: 0,
      })
      const badgeMesh = new Mesh(badgeGeometry, badgeMaterial)
      badgeMesh.rotation.x = -Math.PI / 2
      badgeMesh.position.y = this.hexHeight * 1.5 + 0.1
      badgeMesh.position.z = 0.5
      group.add(badgeMesh)
    }

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, { group, hex: city.hex, type: 'city', entityId: city.id })
  }

  renderWorker(session: Session): void {
    if (!session.hex) return

    const key = this.hexGrid.hexKey(session.hex)

    // Remove existing mesh at this position
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(session.hex)

    // Choose color based on status
    let color: number = PALETTE.sepia
    let labelColor: string = PALETTE_CSS.sepia
    if (session.status === 'working') {
      color = PALETTE.verdigris
      labelColor = PALETTE_CSS.verdigris
    } else if (session.status === 'attention') {
      color = PALETTE.vermillion
      labelColor = PALETTE_CSS.vermillion
    }

    // Worker hex - smaller, positioned around city
    const workerMesh = this.createHexMesh(color, this.workerScale)
    group.add(workerMesh)

    // Worker label - session name, colored by status
    const labelTexture = this.createLabel(session.name, 32, labelColor)
    const labelGeometry = new PlaneGeometry(2.5, 0.65)
    const labelMaterial = new MeshStandardMaterial({
      map: labelTexture,
      transparent: true,
      roughness: 1,
      metalness: 0,
    })
    const labelMesh = new Mesh(labelGeometry, labelMaterial)
    labelMesh.rotation.x = -Math.PI / 2
    labelMesh.position.y = this.hexHeight + 0.1
    group.add(labelMesh)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)

    this.hexMeshes.set(key, { group, hex: session.hex, type: 'worker', entityId: session.id })
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
  getEntityAtHex(hex: HexCoord): { type: 'city' | 'worker' | 'empty'; entityId?: string } | null {
    const key = this.hexGrid.hexKey(hex)
    const data = this.hexMeshes.get(key)
    if (data) {
      return { type: data.type, entityId: data.entityId }
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

    // Create ring (terracotta glow - Cartographic Warmth)
    const ringShape = this.createRingShape(1.12, 0.92)
    const ringGeometry = new ExtrudeGeometry(ringShape, {
      depth: 0.08,
      bevelEnabled: false,
    })
    const ringMaterial = new MeshStandardMaterial({
      color: PALETTE.terracotta,
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
}
