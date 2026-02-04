// WorkerSwarm.ts - Particle swarm rendering for workers
// Replaces ship sprites with murmuration-style ink droplet clouds

import {
  Points,
  PointsMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  Vector3,
  CanvasTexture,
  Group,
  NormalBlending,
  Object3D,
} from 'three'
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

// Simplex noise implementation (3D)
// Based on Stefan Gustavson's work, adapted for TypeScript
const F3 = 1 / 3
const G3 = 1 / 6

// Gradients for 3D noise
const grad3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
]

// Permutation table (shuffled 0-255, doubled for overflow)
const perm = new Uint8Array(512)
const permMod12 = new Uint8Array(512)

// Initialize permutation with a seed
function initPerm(seed: number): void {
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i

  // Shuffle using seed
  let s = seed
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    const tmp = p[i]
    p[i] = p[j]
    p[j] = tmp
  }

  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255]
    permMod12[i] = perm[i] % 12
  }
}

// Initialize with default seed
initPerm(42)

function dot3(g: number[], x: number, y: number, z: number): number {
  return g[0] * x + g[1] * y + g[2] * z
}

function noise3D(x: number, y: number, z: number): number {
  // Skew input space
  const s = (x + y + z) * F3
  const i = Math.floor(x + s)
  const j = Math.floor(y + s)
  const k = Math.floor(z + s)

  const t = (i + j + k) * G3
  const X0 = i - t
  const Y0 = j - t
  const Z0 = k - t
  const x0 = x - X0
  const y0 = y - Y0
  const z0 = z - Z0

  // Determine simplex
  let i1: number, j1: number, k1: number
  let i2: number, j2: number, k2: number

  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1 }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1 }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1 }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1 }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
  }

  const x1 = x0 - i1 + G3
  const y1 = y0 - j1 + G3
  const z1 = z0 - k1 + G3
  const x2 = x0 - i2 + 2 * G3
  const y2 = y0 - j2 + 2 * G3
  const z2 = z0 - k2 + 2 * G3
  const x3 = x0 - 1 + 3 * G3
  const y3 = y0 - 1 + 3 * G3
  const z3 = z0 - 1 + 3 * G3

  const ii = i & 255
  const jj = j & 255
  const kk = k & 255

  let n0 = 0, n1 = 0, n2 = 0, n3 = 0

  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0
  if (t0 >= 0) {
    const gi0 = permMod12[ii + perm[jj + perm[kk]]]
    t0 *= t0
    n0 = t0 * t0 * dot3(grad3[gi0], x0, y0, z0)
  }

  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1
  if (t1 >= 0) {
    const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]
    t1 *= t1
    n1 = t1 * t1 * dot3(grad3[gi1], x1, y1, z1)
  }

  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2
  if (t2 >= 0) {
    const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]
    t2 *= t2
    n2 = t2 * t2 * dot3(grad3[gi2], x2, y2, z2)
  }

  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3
  if (t3 >= 0) {
    const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]
    t3 *= t3
    n3 = t3 * t3 * dot3(grad3[gi3], x3, y3, z3)
  }

  // Scale to [-1, 1]
  return 32 * (n0 + n1 + n2 + n3)
}

// Color gradient: dormant → active
const INK_DORMANT = { r: 0x1a / 255, g: 0x18 / 255, b: 0x16 / 255 }    // #1A1816 deep black
const INK_WARM = { r: 0x6a / 255, g: 0x5a / 255, b: 0x3a / 255 }       // #6A5A3A warm sepia
const INK_FIREFLY = { r: 0xd4 / 255, g: 0xa5 / 255, b: 0x20 / 255 }    // #D4A520 firefly gold

// Create sharp point texture with glow
function createDropletTexture(): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  // Sharp core with subtle glow halo
  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  )
  // Bright sharp core
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.15, 'rgba(255, 255, 255, 0.9)')
  gradient.addColorStop(0.25, 'rgba(255, 255, 255, 0.4)')
  // Subtle glow halo
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.1)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)

  const texture = new CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

// Shared texture for all swarms
let sharedDropletTexture: CanvasTexture | null = null

function getDropletTexture(): CanvasTexture {
  if (!sharedDropletTexture) {
    sharedDropletTexture = createDropletTexture()
  }
  return sharedDropletTexture
}

export interface SwarmConfig {
  particleCount?: number
  baseRadius?: number           // Idle spread radius
  workingRadiusMultiplier?: number  // How much to expand when working
  baseSpeed?: number            // Noise sampling rate (idle)
  workingSpeedMultiplier?: number   // Speed increase when working
  particleSize?: number
  heightOffset?: number         // Y position above vellum
}

const DEFAULT_CONFIG: Required<SwarmConfig> = {
  particleCount: 45,
  baseRadius: 0.6,  // 1.5x bigger swarm spread
  workingRadiusMultiplier: 1.5,
  baseSpeed: 0.15,  // Slow time evolution for smooth noise
  workingSpeedMultiplier: 3.0,
  particleSize: 9,  // Smaller dots
  heightOffset: 0.15,  // Just above vellum, below label
}

export class WorkerSwarm {
  readonly group: Group
  readonly workerId: string
  readonly tmuxSession: string

  private points: Points
  private positions: Float32Array
  private velocities: Float32Array
  private material: PointsMaterial
  private particleCount: number
  private config: Required<SwarmConfig>

  // Animation state
  private activity = 0  // 0 = idle, 1 = working (interpolated)
  private targetActivity = 0
  private noiseOffset: number  // Unique offset per swarm
  private time = 0
  private frameCount = 0  // For throttling idle animation

  // User-adjustable offset from default position (persisted, for dragging)
  userOffset = new Vector3()

  // Label attached to this swarm (so they move together)
  private labelObject: CSS2DObject | null = null

  constructor(workerId: string, tmuxSession: string, config?: SwarmConfig) {
    this.workerId = workerId
    this.tmuxSession = tmuxSession
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.particleCount = this.config.particleCount
    this.noiseOffset = Math.random() * 1000

    this.group = new Group()

    // Initialize particle positions
    this.positions = new Float32Array(this.particleCount * 3)
    this.velocities = new Float32Array(this.particleCount * 3)
    this.initializeParticles()

    // Create point cloud
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3))

    this.material = new PointsMaterial({
      size: this.config.particleSize,
      map: getDropletTexture(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
      vertexColors: false,
      sizeAttenuation: false,  // Manual scaling via setCameraDistance()
    })
    this.setColor(0, 0)  // Start with dormant color, no pulse

    this.points = new Points(geometry, this.material)
    this.points.position.y = this.config.heightOffset
    this.group.add(this.points)

    // Store worker info for hit detection
    this.group.userData = { workerId, tmuxSession }
  }

  private initializeParticles(): void {
    // Distribute particles in a sphere
    for (let i = 0; i < this.particleCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = this.config.baseRadius * Math.cbrt(Math.random())  // Cube root for uniform volume

      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta) * 0.6  // Flatten vertically
      const z = r * Math.cos(phi)

      this.positions[i * 3] = x
      this.positions[i * 3 + 1] = y
      this.positions[i * 3 + 2] = z
      // velocities start at 0 (Float32Array is zero-initialized)
    }
  }

  setActivity(level: number): void {
    this.targetActivity = Math.max(0, Math.min(1, level))
  }

  /** Scale particles based on camera distance - smaller when zoomed out */
  setCameraDistance(distance: number): void {
    // At distance 6: full size, scales down aggressively when zoomed out
    // Min 0.25 at far zoom so particles become fine specks
    const scale = Math.max(0.25, Math.min(1.0, 5 / distance))
    this.cameraScale = scale
  }

  private cameraScale = 1

  private setColor(activity: number, pulse: number): void {
    // 3-stop gradient: dormant (0) → warm (0.3) → firefly (1.0)
    let r: number, g: number, b: number

    if (activity < 0.3) {
      // Dormant to warm
      const t = activity / 0.3
      r = INK_DORMANT.r + (INK_WARM.r - INK_DORMANT.r) * t
      g = INK_DORMANT.g + (INK_WARM.g - INK_DORMANT.g) * t
      b = INK_DORMANT.b + (INK_WARM.b - INK_DORMANT.b) * t
    } else {
      // Warm to firefly
      const t = (activity - 0.3) / 0.7
      r = INK_WARM.r + (INK_FIREFLY.r - INK_WARM.r) * t
      g = INK_WARM.g + (INK_FIREFLY.g - INK_WARM.g) * t
      b = INK_WARM.b + (INK_FIREFLY.b - INK_WARM.b) * t
    }

    // Pulse brightness for active workers (adds glow)
    const brighten = pulse * activity * 0.3
    r = Math.min(1, r + brighten)
    g = Math.min(1, g + brighten)
    b = Math.min(1, b + brighten)

    this.material.color.setRGB(r, g, b)
  }

  update(deltaTime: number): void {
    this.frameCount++

    // Throttle idle swarms: update every 3rd frame (~20fps instead of 60fps)
    // Saves ~66% CPU for idle workers while keeping motion smooth
    const isIdle = this.activity < 0.01 && this.targetActivity === 0
    if (isIdle && this.frameCount % 3 !== 0) {
      return
    }

    // Smooth activity transition (~500ms)
    // Compensate for skipped frames when idle
    const activityRate = deltaTime * (isIdle ? 3 : 1) * 2
    if (this.activity < this.targetActivity) {
      this.activity = Math.min(this.targetActivity, this.activity + activityRate)
    } else if (this.activity > this.targetActivity) {
      this.activity = Math.max(this.targetActivity, this.activity - activityRate)
    }

    // Pulsation for active workers (0-1 sine wave)
    const pulse = (Math.sin(this.time * 3) + 1) / 2

    // Update color with pulse
    this.setColor(this.activity, pulse)

    // Scale by camera distance, pulsate for active workers
    const baseSize = this.config.particleSize * this.cameraScale
    const sizeVariation = baseSize * 0.3 * this.activity * pulse
    this.material.size = baseSize + sizeVariation

    // Calculate current parameters
    const speed = this.config.baseSpeed * (1 + (this.config.workingSpeedMultiplier - 1) * this.activity)
    const radius = this.config.baseRadius * (1 + (this.config.workingRadiusMultiplier - 1) * this.activity)

    // Compensate time for skipped frames when idle
    this.time += deltaTime * speed * (isIdle ? 3 : 1)

    // Update each particle
    const noiseScale = 1.5
    const returnForce = 0.5  // How strongly particles return to center

    for (let i = 0; i < this.particleCount; i++) {
      const i3 = i * 3
      const x = this.positions[i3]
      const y = this.positions[i3 + 1]
      const z = this.positions[i3 + 2]

      // Sample noise for velocity
      // Per-particle offset prevents convergence when particles get close
      const particleOffset = i * 7.3  // Prime-ish spacing in noise space
      const noiseX = x * noiseScale + this.noiseOffset + particleOffset
      const noiseY = y * noiseScale + this.noiseOffset
      const noiseZ = z * noiseScale + this.time

      const vx = noise3D(noiseX, noiseY, noiseZ)
      const vy = noise3D(noiseX + 100, noiseY + 100, noiseZ + 100)
      const vz = noise3D(noiseX + 200, noiseY + 200, noiseZ + 200)

      // Apply velocity with smoothing
      const smoothing = 0.15
      this.velocities[i3] += (vx - this.velocities[i3]) * smoothing
      this.velocities[i3 + 1] += (vy - this.velocities[i3 + 1]) * smoothing
      this.velocities[i3 + 2] += (vz - this.velocities[i3 + 2]) * smoothing

      // Move particle - dormant: slow drift, active: lively undulation
      const moveSpeed = 0.3 + this.activity * 2.7  // 0.3 dormant → 3.0 active
      let newX = x + this.velocities[i3] * deltaTime * moveSpeed
      let newY = y + this.velocities[i3 + 1] * deltaTime * moveSpeed
      let newZ = z + this.velocities[i3 + 2] * deltaTime * moveSpeed

      // Return force toward center (keeps swarm cohesive)
      const dist = Math.sqrt(newX * newX + newY * newY + newZ * newZ)
      if (dist > radius * 0.5) {
        const pull = returnForce * deltaTime * (dist / radius)
        newX -= (newX / dist) * pull
        newY -= (newY / dist) * pull
        newZ -= (newZ / dist) * pull
      }

      // Clamp to radius
      const newDist = Math.sqrt(newX * newX + newY * newY + newZ * newZ)
      if (newDist > radius) {
        const scale = radius / newDist
        newX *= scale
        newY *= scale
        newZ *= scale
      }

      this.positions[i3] = newX
      this.positions[i3 + 1] = newY
      this.positions[i3 + 2] = newZ
    }

    // Update geometry - copy positions to attribute array (they're separate arrays)
    const posAttr = this.points.geometry.getAttribute('position') as Float32BufferAttribute
    posAttr.array.set(this.positions)
    posAttr.needsUpdate = true
  }

  /**
   * Attach a label to this swarm (moves with swarm)
   */
  setLabel(labelObj: CSS2DObject): void {
    // Remove old label if present
    if (this.labelObject) {
      this.group.remove(this.labelObject)
    }
    this.labelObject = labelObj
    // Position label clearly above swarm particles (swarm at y=0.15)
    labelObj.position.set(0, 0.65, 0)
    this.group.add(labelObj)
  }

  /**
   * Get the attached label
   */
  getLabel(): CSS2DObject | null {
    return this.labelObject
  }

  /**
   * Hide the label (when card is open, label becomes card header)
   */
  hideLabel(): void {
    if (this.labelObject) {
      this.labelObject.element.style.opacity = '0'
      this.labelObject.element.style.pointerEvents = 'none'
    }
  }

  /**
   * Show the label (when card closes)
   */
  showLabel(): void {
    if (this.labelObject) {
      this.labelObject.element.style.opacity = ''
      this.labelObject.element.style.pointerEvents = ''
    }
  }

  /**
   * Add an object to the swarm group (e.g., conversation card)
   */
  addChild(obj: Object3D): void {
    this.group.add(obj)
  }

  /**
   * Remove an object from the swarm group
   */
  removeChild(obj: Object3D): void {
    this.group.remove(obj)
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
    // Note: don't dispose shared droplet texture
  }
}
