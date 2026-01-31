// CoastlineRenderer.ts - Portolan-style coastlines with hatching
// Ported from reference/combined-playground.html

import {
  Group,
  BufferGeometry,
  LineSegments,
  LineBasicMaterial,
  Float32BufferAttribute,
  Line,
} from 'three'

// Seeded RNG (mulberry32) for reproducible generation
function mulberry32(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

interface Point {
  x: number
  y: number
  t: number
}

// City position for coastline-through-cities mode
export interface CityPosition {
  id: string
  name: string
  x: number  // World X coordinate
  z: number  // World Z coordinate
}

export interface CoastlineParams {
  seed: number
  mapRadius: number

  // Coastline shape
  displacement: number
  smoothing: number

  // City positions (optional) - if provided, coastline passes through these points
  cityPositions?: CityPosition[]

  // Hatching
  showHatching: boolean
  hatchDensity: number
  hatchLength: number
  hatchWidth: number
  hatchOpacity: number

  // Coastline stroke
  coastlineWidth: number
  coastlineOpacity: number
  coastlineColor: number
}

export const DEFAULT_COASTLINE_PARAMS: CoastlineParams = {
  seed: 42,
  mapRadius: 50,

  displacement: 0.35,
  smoothing: 3,

  showHatching: true,
  hatchDensity: 40,  // Reduced frequency
  hatchLength: 0.25,  // Shorter hatches
  hatchWidth: 1.5,
  hatchOpacity: 0.6,

  coastlineWidth: 2.0,
  coastlineOpacity: 0.8,
  coastlineColor: 0x2a2420,  // Dark brown ink
}

// Gaussian-weighted moving average smoothing
function smoothPoints(points: Point[], windowSize: number): Point[] {
  const half = Math.floor(windowSize / 2)
  const result: Point[] = []

  for (let i = 0; i < points.length; i++) {
    let sumX = 0, sumY = 0, sumT = 0, count = 0
    for (let j = -half; j <= half; j++) {
      const idx = Math.max(0, Math.min(points.length - 1, i + j))
      const weight = 1 - Math.abs(j) / (half + 1)
      sumX += points[idx].x * weight
      sumY += points[idx].y * weight
      sumT += points[idx].t * weight
      count += weight
    }
    result.push({ x: sumX / count, y: sumY / count, t: sumT / count })
  }

  return result
}

// Inland direction: northwest (normalized)
const INLAND_DIR = { x: -1 / Math.SQRT2, z: -1 / Math.SQRT2 }
// Coast direction: perpendicular to inland (southwest to northeast)
const COAST_DIR = { x: INLAND_DIR.z, z: -INLAND_DIR.x }  // Rotate 90° CW

// City position along coastline (returned by generateCoastlineFirst)
export interface CityCoastlinePosition {
  id: string
  name: string
  x: number      // World X position on coastline
  z: number      // World Z position on coastline
  coastlineT: number  // Parameter along coastline (0-1)
  tangentAngle: number  // Angle of coastline at this point (for label orientation)
}

// Generate coastline FIRST, then compute where cities go along it
// This is the correct approach: coastline has natural shape, cities are placed on it
function generateCoastlineFirst(
  numCities: number,
  centerX: number,
  centerZ: number,
  seed: number
): { points: Point[], cityPositions: { t: number, x: number, z: number, angle: number }[] } {
  const rng = mulberry32(seed + 1000)

  // Coastline length scales with number of cities
  const spacingPerCity = 6  // World units between cities
  const coastLength = Math.max(20, numCities * spacingPerCity)
  const numPoints = Math.max(50, numCities * 15)  // Enough points for smooth curve

  // Generate base coastline as a line with gentle curves
  // Runs SW to NE, centered on the given position
  const points: Point[] = []

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints

    // Base position along coast direction
    const baseX = centerX + (t - 0.5) * coastLength * COAST_DIR.x
    const baseZ = centerZ + (t - 0.5) * coastLength * COAST_DIR.z

    // Add gentle undulation perpendicular to coast
    // Multiple frequencies for natural look, but gentle amplitudes
    const wave1 = Math.sin(t * Math.PI * 2 + seed * 0.1) * coastLength * 0.08
    const wave2 = Math.sin(t * Math.PI * 5 + seed * 0.2) * coastLength * 0.03
    const wave3 = Math.sin(t * Math.PI * 11 + seed * 0.3) * coastLength * 0.015
    const undulation = wave1 + wave2 + wave3

    // Apply perpendicular offset (toward/away from inland)
    const x = baseX + INLAND_DIR.x * undulation
    const z = baseZ + INLAND_DIR.z * undulation

    points.push({ x, y: z, t })
  }

  // Calculate city positions along coastline
  // Distributed evenly, with small random jitter for natural feel
  const cityPositions: { t: number, x: number, z: number, angle: number }[] = []

  for (let i = 0; i < numCities; i++) {
    // Even distribution with padding at ends
    const baseT = (i + 1) / (numCities + 1)
    // Small random offset
    const jitter = (rng() - 0.5) * 0.3 / numCities
    const t = Math.max(0.05, Math.min(0.95, baseT + jitter))

    // Find the point on coastline at this t
    const idx = Math.floor(t * (points.length - 1))
    const localT = (t * (points.length - 1)) - idx
    const p1 = points[idx]
    const p2 = points[Math.min(idx + 1, points.length - 1)]

    const x = p1.x + (p2.x - p1.x) * localT
    const z = p1.y + (p2.y - p1.y) * localT

    // Calculate inland-pointing perpendicular angle for label orientation
    const dx = p2.x - p1.x
    const dz = p2.y - p1.y
    const len = Math.sqrt(dx * dx + dz * dz)

    // Get perpendicular directions (both options)
    const perpX1 = -dz / (len || 1)
    const perpZ1 = dx / (len || 1)

    // Pick the perpendicular that points more toward inland (northwest)
    const dot = perpX1 * INLAND_DIR.x + perpZ1 * INLAND_DIR.z
    const inlandPerpX = dot >= 0 ? perpX1 : -perpX1
    const inlandPerpZ = dot >= 0 ? perpZ1 : -perpZ1

    // Angle of the inland-pointing perpendicular
    const angle = Math.atan2(inlandPerpZ, inlandPerpX)

    cityPositions.push({ t, x, z, angle })
  }

  return { points, cityPositions }
}

// Apply hand-drawn wobble to coastline
// Portolan charts have constant fine-scale irregularity, not smooth curves with bays
// This simulates the natural hand tremor of drawing with a pen
function applyHandDrawnWobble(points: Point[], wobbleAmount: number, seed: number): Point[] {
  const rng = mulberry32(seed + 3000)

  return points.map((p, i) => {
    // Skip first and last points to preserve endpoints
    if (i === 0 || i === points.length - 1) return p

    // Calculate local perpendicular direction
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 0.001) return p

    const perpX = -dy / len
    const perpY = dx / len

    // Random wobble perpendicular to coastline direction
    // This creates the hand-drawn quality seen in real portolan charts
    const wobble = (rng() - 0.5) * 2 * wobbleAmount

    return {
      x: p.x + perpX * wobble,
      y: p.y + perpY * wobble,
      t: p.t,
    }
  })
}

// Create hatching (perpendicular tick marks) along coastline
function createHatchingGeometry(points: Point[], params: CoastlineParams): BufferGeometry {
  const positions: number[] = []
  const hatchRng = mulberry32(params.seed + 5000)

  // Calculate total path length
  let totalLength = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    totalLength += Math.sqrt(dx * dx + dy * dy)
  }

  // Distribute hatches evenly along the path
  const spacing = totalLength / params.hatchDensity
  let accumulated = 0
  let currentSegment = 0

  for (let h = 0; h < params.hatchDensity; h++) {
    const targetDist = h * spacing + (hatchRng() - 0.5) * spacing * 0.3  // Slight jitter

    // Walk along path to find position
    while (currentSegment < points.length - 1) {
      const p1 = points[currentSegment]
      const p2 = points[currentSegment + 1]
      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const segLen = Math.sqrt(dx * dx + dy * dy)

      if (accumulated + segLen >= targetDist) {
        // Found the segment
        const localT = segLen > 0 ? (targetDist - accumulated) / segLen : 0
        const x = p1.x + dx * localT
        const z = p1.y + dy * localT  // y in 2D -> z in 3D (XZ plane)

        // Right-hand perpendicular: as you walk along coast from SW to NE, sea is on your right
        // For tangent (dx, dy), right perpendicular is (dy, -dx)
        // This consistently points seaward for our SW-to-NE sorted coastline
        const len = segLen > 0.001 ? segLen : 1
        const normalX = dy / len   // Right-hand perpendicular
        const normalZ = -dx / len

        // Slight variation in hatch length for organic look (less variance than before)
        const lengthVar = params.hatchLength * (0.85 + hatchRng() * 0.3)

        // Add line segment (start point, end point) - hatches point toward sea
        positions.push(x, 0, z)  // y=0 is ground level
        positions.push(x + normalX * lengthVar, 0, z + normalZ * lengthVar)

        break
      }

      accumulated += segLen
      currentSegment++
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  return geometry
}

// Exported point type for use by other renderers
export interface CoastlinePoint {
  x: number  // World X coordinate
  y: number  // World Z coordinate (confusingly named, but matches internal usage)
  t: number  // Parameter along coastline (0-1)
}

// Result of coastline creation - includes geometry, points, AND computed city positions
export interface CoastlineResult {
  group: Group
  points: CoastlinePoint[]  // Coastline points in world coordinates
  cityPositions: CityCoastlinePosition[]  // Where cities should be placed along coastline
}

// Main function to create all coastline elements
export function createCoastline(params: Partial<CoastlineParams> = {}): CoastlineResult {
  const p = { ...DEFAULT_COASTLINE_PARAMS, ...params }
  const group = new Group()

  // NEW APPROACH: Generate coastline FIRST, then place cities along it
  // Coastline has its own natural shape; cities are labels placed on it

  // Calculate center point for coastline (use city positions as hint, or default)
  let centerX = 0, centerZ = 0
  const numCities = p.cityPositions?.length ?? 0
  if (p.cityPositions && numCities > 0) {
    centerX = p.cityPositions.reduce((sum, c) => sum + c.x, 0) / numCities
    centerZ = p.cityPositions.reduce((sum, c) => sum + c.z, 0) / numCities
  }

  // Generate coastline and compute city positions
  const { points: basePoints, cityPositions: computedCityPositions } = generateCoastlineFirst(
    Math.max(1, numCities),
    centerX,
    centerZ,
    p.seed
  )

  // Apply hand-drawn wobble for authentic portolan look
  let coastlinePoints = applyHandDrawnWobble(
    basePoints,
    p.displacement * 0.4,  // subtle wobble
    p.seed
  )

  // Very light smoothing
  if (p.smoothing > 0) {
    const windowSize = Math.max(3, p.smoothing)
    coastlinePoints = smoothPoints(coastlinePoints, windowSize)
  }

  // Map computed positions to city names (sorted by discovery time / original order)
  const cityNames = p.cityPositions?.map(c => ({ id: c.id, name: c.name })) ?? []
  const finalCityPositions: CityCoastlinePosition[] = computedCityPositions.map((pos, i) => {
    const city = cityNames[i] || { id: `city_${i}`, name: `City ${i}` }
    return {
      id: city.id,
      name: city.name,
      x: pos.x,
      z: pos.z,
      coastlineT: pos.t,
      tangentAngle: pos.angle,
    }
  })

  // Coastline stroke
  const coastlineGeometry = new BufferGeometry()
  const coastlinePositions: number[] = []
  for (const p of coastlinePoints) {
    coastlinePositions.push(p.x, 0.01, p.y)  // Slightly above ground
  }
  coastlineGeometry.setAttribute('position', new Float32BufferAttribute(coastlinePositions, 3))

  const coastlineMaterial = new LineBasicMaterial({
    color: p.coastlineColor,
    transparent: true,
    opacity: p.coastlineOpacity,
    linewidth: p.coastlineWidth,
  })
  const coastlineLine = new Line(coastlineGeometry, coastlineMaterial)
  coastlineLine.position.y = 0.01
  group.add(coastlineLine)

  // Hatching marks
  if (p.showHatching) {
    const hatchGeometry = createHatchingGeometry(coastlinePoints, p)
    const hatchMaterial = new LineBasicMaterial({
      color: p.coastlineColor,
      transparent: true,
      opacity: p.hatchOpacity,
      linewidth: p.hatchWidth,
    })
    const hatchLines = new LineSegments(hatchGeometry, hatchMaterial)
    hatchLines.position.y = 0.01
    group.add(hatchLines)
  }

  return { group, points: coastlinePoints, cityPositions: finalCityPositions }
}

/**
 * Find the nearest coastline point to a world position and calculate perpendicular angle
 * Returns angle in radians for text rotation (perpendicular to coast, pointing into land)
 *
 * For Three.js: when mesh has rotation.x = -π/2 (lying flat on XZ plane),
 * rotation.z rotates around the world Y axis. We return the angle to make
 * text perpendicular to the coastline tangent.
 */
export function getCoastlineAngleAt(
  worldX: number,
  worldZ: number,
  points: CoastlinePoint[],
  lookAhead = 5  // Number of points to look ahead/behind for tangent
): { angle: number; normalX: number; normalZ: number; nearestX: number; nearestZ: number } | null {
  if (points.length < 3) return null

  // Find nearest point on coastline
  let minDist = Infinity
  let nearestIdx = 0

  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - worldX
    const dz = points[i].y - worldZ  // .y is world Z
    const dist = dx * dx + dz * dz
    if (dist < minDist) {
      minDist = dist
      nearestIdx = i
    }
  }

  // Calculate tangent using points before and after
  // Use fixed lookAhead, clamped to available points
  const actualLookAhead = Math.min(lookAhead, Math.floor(points.length / 4), 10)
  const lookBack = Math.max(1, actualLookAhead)
  const lookForward = Math.max(1, actualLookAhead)

  const p0 = points[Math.max(0, nearestIdx - lookBack)]
  const p1 = points[Math.min(points.length - 1, nearestIdx + lookForward)]

  // Tangent vector along coastline
  const tangentX = p1.x - p0.x
  const tangentZ = p1.y - p0.y  // .y is world Z
  const len = Math.sqrt(tangentX * tangentX + tangentZ * tangentZ)

  if (len < 0.001) return null

  // Left-hand perpendicular points inland (opposite of right-hand which points seaward)
  // For tangent (tx, tz), left perpendicular is (-tz, tx)
  // This points inland for our SW-to-NE sorted coastline
  const normalX = -tangentZ / len
  const normalZ = tangentX / len

  // Angle for text rotation in XZ plane
  // This is the angle the normal makes with the positive X axis
  // When applied to a flat mesh (rotation.x = -π/2), rotation.z rotates in XZ
  const angle = Math.atan2(normalZ, normalX)

  return {
    angle,
    normalX,
    normalZ,
    nearestX: points[nearestIdx].x,
    nearestZ: points[nearestIdx].y  // .y is world Z
  }
}
