// HexGrid.ts - Hexagonal grid coordinate system
// Ported from v1: /Users/cd280747/Documents/projects/hexarchy/src/scene/HexGrid.ts

import type { HexCoord, CartesianCoord } from '../state/types'

export class HexGrid {
  size: number
  hexRadius: number

  // Precomputed hex geometry constants
  private readonly sqrt3 = Math.sqrt(3)

  constructor(size: number, hexRadius: number) {
    this.size = size
    this.hexRadius = hexRadius
  }

  /**
   * Convert axial hex coordinates to cartesian world coordinates
   */
  axialToCartesian(hex: HexCoord): CartesianCoord {
    const x = this.hexRadius * this.sqrt3 * (hex.q + hex.r / 2)
    const z = this.hexRadius * (3 / 2) * hex.r
    return { x, z }
  }

  /**
   * Convert cartesian world coordinates to axial hex coordinates
   */
  cartesianToHex(x: number, z: number): HexCoord {
    const q = (this.sqrt3 / 3 * x - z / 3) / this.hexRadius
    const r = (2 / 3 * z) / this.hexRadius
    return this.roundHex({ q, r })
  }

  /**
   * Round fractional hex coordinates to nearest hex
   */
  roundHex(hex: HexCoord): HexCoord {
    let q = Math.round(hex.q)
    let r = Math.round(hex.r)
    const s = Math.round(-hex.q - hex.r)

    const qDiff = Math.abs(q - hex.q)
    const rDiff = Math.abs(r - hex.r)
    const sDiff = Math.abs(s - (-hex.q - hex.r))

    if (qDiff > rDiff && qDiff > sDiff) {
      q = -r - s
    } else if (rDiff > sDiff) {
      r = -q - s
    }

    return { q, r }
  }

  /**
   * Get hex distance between two hexes
   */
  distance(a: HexCoord, b: HexCoord): number {
    return (
      Math.abs(a.q - b.q) +
      Math.abs(a.q + a.r - b.q - b.r) +
      Math.abs(a.r - b.r)
    ) / 2
  }

  /**
   * Get all hexes within radius of center
   */
  getHexesInRadius(center: HexCoord, radius: number): HexCoord[] {
    const hexes: HexCoord[] = []

    for (let q = -radius; q <= radius; q++) {
      for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
        hexes.push({
          q: center.q + q,
          r: center.r + r,
        })
      }
    }

    return hexes
  }

  /**
   * Get the 6 neighbors of a hex
   */
  getNeighbors(hex: HexCoord): HexCoord[] {
    const directions: HexCoord[] = [
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ]

    return directions.map(d => ({
      q: hex.q + d.q,
      r: hex.r + d.r,
    }))
  }

  /**
   * Check if hex is within grid bounds
   */
  isInBounds(hex: HexCoord): boolean {
    return this.distance(hex, { q: 0, r: 0 }) <= this.size
  }

  /**
   * Find a free hex near target, avoiding occupied positions
   */
  findFreeHex(
    target: HexCoord,
    occupied: Set<string>,
    maxRadius = 10
  ): HexCoord | null {
    // Check target first
    const targetKey = `${target.q},${target.r}`
    if (!occupied.has(targetKey) && this.isInBounds(target)) {
      return target
    }

    // Spiral outward
    for (let radius = 1; radius <= maxRadius; radius++) {
      const ring = this.getHexRing(target, radius)
      for (const hex of ring) {
        const key = `${hex.q},${hex.r}`
        if (!occupied.has(key) && this.isInBounds(hex)) {
          return hex
        }
      }
    }

    console.warn('HexGrid: No free hex found, returning target')
    return target
  }

  /**
   * Get hexes forming a ring at distance radius from center
   */
  getHexRing(center: HexCoord, radius: number): HexCoord[] {
    if (radius === 0) return [center]

    const ring: HexCoord[] = []
    const directions: HexCoord[] = [
      { q: 1, r: 0 },
      { q: 0, r: 1 },
      { q: -1, r: 1 },
      { q: -1, r: 0 },
      { q: 0, r: -1 },
      { q: 1, r: -1 },
    ]

    // Start at one corner
    let hex: HexCoord = {
      q: center.q - radius,
      r: center.r + radius,
    }

    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < radius; j++) {
        ring.push({ ...hex })
        hex = {
          q: hex.q + directions[i].q,
          r: hex.r + directions[i].r,
        }
      }
    }

    return ring
  }

  /**
   * Get corner vertices of a hex for rendering (pointy-top)
   */
  getHexCorners(hex: HexCoord): { x: number; z: number }[] {
    const center = this.axialToCartesian(hex)
    const corners: { x: number; z: number }[] = []

    for (let i = 0; i < 6; i++) {
      // Pointy-top: start at -90° to match axialToCartesian spacing
      const angle = (Math.PI / 3) * i - Math.PI / 2
      corners.push({
        x: center.x + this.hexRadius * Math.cos(angle),
        z: center.z + this.hexRadius * Math.sin(angle),
      })
    }

    return corners
  }

  /**
   * Generate hex key for use in maps/sets
   */
  hexKey(hex: HexCoord): string {
    return `${hex.q},${hex.r}`
  }
}
