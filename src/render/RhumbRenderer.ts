// RhumbRenderer.ts - Rhumb lines and compass roses for portolan-style maps
// Ported from reference/combined-playground.html

import {
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  LineBasicMaterial,
  Group,
  Mesh,
  CircleGeometry,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  DoubleSide,
} from 'three'

// Seeded random number generator (Mulberry32)
function mulberry32(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

export interface RhumbParams {
  seed: number
  primaryRoses: number       // 1-4
  secondaryRoses: number     // 0-12
  primaryDirections: number  // Usually 16
  secondaryDirections: number // Usually 8
  primaryOpacity: number     // 0-1
  secondaryOpacity: number   // 0-1
  mapRadius: number          // World units - how far lines extend
  // Optional center point - roses cluster around this position
  // If not provided, uses origin (0, 0)
  center?: { x: number; z: number }
  // Cluster radius - how far from center roses are placed
  clusterRadius?: number
}

export const DEFAULT_RHUMB_PARAMS: RhumbParams = {
  seed: 42,
  primaryRoses: 2,
  secondaryRoses: 8,         // More secondary roses for density
  primaryDirections: 16,
  secondaryDirections: 8,
  primaryOpacity: 0.35,
  secondaryOpacity: 0.20,
  mapRadius: 50,  // Match vellum plane size
  clusterRadius: 15,  // Default cluster radius in world units
}

// Colors from authentic portolan charts — two-tone system (black + red)
// Reference: default-3.jpg shows clear black network with red cardinal accents
const COLORS = {
  primary: 0x2A2420,      // Dark ink black (primary rose lines)
  secondary: 0x3D3530,    // Slightly lighter black (secondary rose lines)
  accent: 0x8B2323,       // Deep manuscript red (cardinal directions)
  cardinal: 0x2A5A2A,     // Green for compass rose cardinal points
  intercardinal: 0x8B4513,
  intermediate: 0x6B4423,
  tertiary: 0xC8A878,     // Light tan
  vellum: 0xF5EEE1,
  outline: 0x3A3020,
  gold: 0x9A7B35,
}

interface RosePosition {
  x: number
  z: number
  isPrimary: boolean
}

/**
 * Create rhumb lines and compass roses for a portolan-style map
 */
export function createRhumbLines(params: RhumbParams = DEFAULT_RHUMB_PARAMS): Group {
  const group = new Group()
  const rng = mulberry32(params.seed)

  // Generate rose positions
  const roses = generateRosePositions(params, rng)

  // Create rhumb lines
  const linesGroup = createLines(roses, params)
  group.add(linesGroup)

  // Create compass roses
  for (const rose of roses) {
    const roseGroup = createCompassRose(rose.x, rose.z, rose.isPrimary)
    group.add(roseGroup)
  }

  return group
}

function generateRosePositions(params: RhumbParams, rng: () => number): RosePosition[] {
  const positions: RosePosition[] = []
  const center = params.center || { x: 0, z: 0 }
  const clusterRadius = params.clusterRadius || 15

  // Primary roses - one at/near center, others spread in a ring
  // First primary rose near center (slight offset for visual interest)
  if (params.primaryRoses > 0) {
    positions.push({
      x: center.x + (rng() - 0.5) * clusterRadius * 0.3,
      z: center.z + (rng() - 0.5) * clusterRadius * 0.3,
      isPrimary: true,
    })
  }

  // Additional primary roses in a ring around center
  for (let i = 1; i < params.primaryRoses; i++) {
    const angle = ((i - 1) / (params.primaryRoses - 1)) * Math.PI * 2 + rng() * 0.4
    const radius = clusterRadius * (0.6 + rng() * 0.3)
    positions.push({
      x: center.x + Math.cos(angle) * radius,
      z: center.z + Math.sin(angle) * radius,
      isPrimary: true,
    })
  }

  // Secondary roses - distributed around and beyond the primary ring
  // Creates the characteristic dense web of portolan charts
  const minSeparation = clusterRadius * 0.25  // Closer together for density

  for (let i = 0; i < params.secondaryRoses; i++) {
    let x: number, z: number
    let attempts = 0

    do {
      // Mix of inner and outer placements
      const angle = rng() * Math.PI * 2
      // Varied radii: some close to center, some extending out
      const radiusFactor = i < params.secondaryRoses / 2
        ? 0.4 + rng() * 0.5  // Inner roses
        : 0.7 + rng() * 0.8  // Outer roses
      const radius = clusterRadius * radiusFactor
      x = center.x + Math.cos(angle) * radius
      z = center.z + Math.sin(angle) * radius
      attempts++

      // Check if too close to existing roses
      let tooClose = false
      for (const pos of positions) {
        const dx = pos.x - x
        const dz = pos.z - z
        if (Math.sqrt(dx * dx + dz * dz) < minSeparation) {
          tooClose = true
          break
        }
      }
      if (!tooClose) break
    } while (attempts < 15)

    positions.push({ x, z, isPrimary: false })
  }

  return positions
}

function createLines(roses: RosePosition[], params: RhumbParams): Group {
  const group = new Group()
  const maxLen = params.mapRadius * 2  // Lines extend to edge

  // Separate geometry for primary and secondary lines
  const primaryPositions: number[] = []
  const secondaryPositions: number[] = []
  const accentPositions: number[] = []

  for (const rose of roses) {
    const directions = rose.isPrimary ? params.primaryDirections : params.secondaryDirections

    for (let i = 0; i < directions; i++) {
      const angle = (i / directions) * Math.PI * 2
      const isCardinal = i % (directions / 4) === 0

      // Line from rose center to edge
      const endX = rose.x + Math.cos(angle) * maxLen
      const endZ = rose.z + Math.sin(angle) * maxLen

      // Y position just above vellum plane
      const y = 0.01

      const positions = isCardinal
        ? accentPositions
        : rose.isPrimary
          ? primaryPositions
          : secondaryPositions

      positions.push(rose.x, y, rose.z)
      positions.push(endX, y, endZ)
    }
  }

  // Create line segments for each category
  if (primaryPositions.length > 0) {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(primaryPositions, 3))
    const mat = new LineBasicMaterial({
      color: COLORS.primary,
      transparent: true,
      opacity: params.primaryOpacity,
      linewidth: 1,  // Note: linewidth > 1 only works on some platforms
    })
    group.add(new LineSegments(geo, mat))
  }

  if (secondaryPositions.length > 0) {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(secondaryPositions, 3))
    const mat = new LineBasicMaterial({
      color: COLORS.secondary,
      transparent: true,
      opacity: params.secondaryOpacity,
      linewidth: 1,
    })
    group.add(new LineSegments(geo, mat))
  }

  if (accentPositions.length > 0) {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(accentPositions, 3))
    const mat = new LineBasicMaterial({
      color: COLORS.accent,
      transparent: true,
      // Red cardinal lines should be noticeably more prominent than black network
      opacity: Math.min(1, params.primaryOpacity * 2.5),
      linewidth: 1,
    })
    group.add(new LineSegments(geo, mat))
  }

  return group
}

/**
 * Create an elaborate compass rose at the given position
 */
function createCompassRose(x: number, z: number, isPrimary: boolean): Group {
  const group = new Group()
  const size = isPrimary ? 1.4 : 0.8  // World units

  // Position rose above the rhumb lines
  const y = 0.02

  // Outer ring
  const outerRing = createRing(size, size * 0.02)
  outerRing.position.set(x, y, z)
  group.add(outerRing)

  // Inner ring
  const innerRing = createRing(size * 0.85, size * 0.015)
  innerRing.position.set(x, y, z)
  group.add(innerRing)

  // Directional points
  const numPoints = isPrimary ? 32 : 16

  // Layer 1: Tertiary (32-point, shortest)
  if (numPoints >= 32) {
    for (let i = 0; i < 32; i++) {
      if (i % 2 !== 0) {
        const angle = (i / 32) * Math.PI * 2
        const point = createRosePoint(angle, size * 0.55, size * 0.08, COLORS.tertiary)
        point.position.set(x, y + 0.001, z)
        group.add(point)
      }
    }
  }

  // Layer 2: Intermediate (16-point, medium)
  if (numPoints >= 16) {
    for (let i = 0; i < 16; i++) {
      if (i % 2 !== 0) {
        const angle = (i / 16) * Math.PI * 2
        const point = createRosePoint(angle, size * 0.70, size * 0.10, COLORS.intermediate)
        point.position.set(x, y + 0.002, z)
        group.add(point)
      }
    }
  }

  // Layer 3: Intercardinal (8-point, longer)
  for (let i = 0; i < 8; i++) {
    if (i % 2 !== 0) {
      const angle = (i / 8) * Math.PI * 2
      const point = createRosePoint(angle, size * 0.85, size * 0.12, COLORS.intercardinal)
      point.position.set(x, y + 0.003, z)
      group.add(point)
    }
  }

  // Layer 4: Cardinal (4-point, longest)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2
    const point = createRosePoint(angle, size * 1.0, size * 0.14, COLORS.cardinal)
    point.position.set(x, y + 0.004, z)
    group.add(point)
  }

  // Central ornament
  const center1 = createCircle(size * 0.25, COLORS.vellum)
  center1.position.set(x, y + 0.005, z)
  group.add(center1)

  const center2 = createCircle(size * 0.18, COLORS.intercardinal)
  center2.position.set(x, y + 0.006, z)
  group.add(center2)

  const center3 = createCircle(size * 0.10, COLORS.gold)
  center3.position.set(x, y + 0.007, z)
  group.add(center3)

  const center4 = createCircle(size * 0.05, COLORS.vellum)
  center4.position.set(x, y + 0.008, z)
  group.add(center4)

  return group
}

function createRing(radius: number, thickness: number): Mesh {
  // Create ring as outer circle minus inner circle
  const shape = new Shape()
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false)
  const hole = new Shape()
  hole.absarc(0, 0, radius - thickness, 0, Math.PI * 2, true)
  shape.holes.push(hole)

  const geometry = new ShapeGeometry(shape)
  const material = new MeshBasicMaterial({
    color: COLORS.outline,
    side: DoubleSide,
    transparent: true,
    opacity: 0.7,
  })

  const mesh = new Mesh(geometry, material)
  mesh.rotation.x = -Math.PI / 2  // Lie flat on XZ plane
  return mesh
}

function createCircle(radius: number, color: number): Mesh {
  const geometry = new CircleGeometry(radius, 32)
  const material = new MeshBasicMaterial({
    color,
    side: DoubleSide,
  })
  const mesh = new Mesh(geometry, material)
  mesh.rotation.x = -Math.PI / 2
  return mesh
}

/**
 * Create a diamond-shaped directional point for the compass rose
 */
function createRosePoint(angle: number, length: number, baseWidth: number, color: number): Mesh {
  // Diamond/kite shape pointing in direction of angle
  const shape = new Shape()

  // Tip of the diamond
  const tipX = Math.cos(angle) * length
  const tipZ = Math.sin(angle) * length

  // Perpendicular direction for base width
  const perpAngle = angle + Math.PI / 2
  const baseX = Math.cos(perpAngle) * baseWidth
  const baseZ = Math.sin(perpAngle) * baseWidth

  // Draw diamond shape (in XZ plane, rotated to XY for Shape)
  shape.moveTo(0, 0)
  shape.lineTo(baseX, baseZ)
  shape.lineTo(tipX, tipZ)
  shape.lineTo(-baseX, -baseZ)
  shape.closePath()

  const geometry = new ShapeGeometry(shape)
  const material = new MeshBasicMaterial({
    color,
    side: DoubleSide,
  })

  const mesh = new Mesh(geometry, material)
  mesh.rotation.x = -Math.PI / 2  // Lie flat on XZ plane
  return mesh
}

/**
 * Update rhumb lines with new parameters
 * Returns a new Group (caller should replace the old one)
 */
export function updateRhumbLines(params: RhumbParams): Group {
  return createRhumbLines(params)
}
