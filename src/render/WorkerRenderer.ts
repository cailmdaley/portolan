// WorkerRenderer.ts - Marauder's Map style workers with force simulation
// Workers wander near their city, avoiding collision, with names following

import {
  Scene,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  DoubleSide,
  CanvasTexture,
  Vector2,
  TextureLoader,
  Texture,
} from 'three'
import type { Session, City, Activity } from '../state/types'
import { HexGrid } from './HexGrid'

// A single footprint in the trail
interface Footprint {
  mesh: Mesh
  age: number        // Time since placed (for fading)
  isLeft: boolean    // Alternating left/right feet
  permanent: boolean // If true, don't fade (standing footprints when stopped)
}

// Internal worker state for simulation
interface WorkerState {
  id: string
  name: string
  tmuxSession: string
  cityId: string | null
  status: 'idle' | 'working'

  // Physics state
  position: Vector2      // Current animated world position (x, z)
  velocity: Vector2      // Current velocity
  heading: number        // Current facing direction (radians) - changes gradually
  targetHeading: number  // Desired direction - heading steers toward this
  homePosition: Vector2  // City position (anchor point)
  lastFootprintPos: Vector2  // Where we last placed a footprint
  nextFootIsLeft: boolean    // Alternating feet

  // Rendering
  group: Group
  markerMesh: Mesh       // Current position indicator (small dot)
  labelMesh: Mesh
  activityMesh: Mesh
  footprints: Footprint[]  // Trail of footprints on the map
}

// Steering simulation parameters - smooth curves, no u-turns
const SIMULATION = {
  // Steering behavior
  maxTurnRate: Math.PI / 4,   // Max radians per second (~45°/sec) - gentle curves
  targetHeadingInterval: 3.0, // Seconds between picking new random target direction

  // Movement
  walkSpeed: 0.35,            // World units per second (slow, contemplative pace)
  maxWanderRadius: 4.0,       // Max distance from home
  minDistanceFromCity: 1.5,   // Min distance from city center

  // Corrections (gentle steering back toward valid area)
  homingStrength: 0.5,        // How strongly to steer toward home when too far
  repulsionRadius: 2.0,       // Distance at which workers avoid each other
  repulsionStrength: 0.8,     // How strongly to steer away from others

  // Animation - ONLY working workers move
  // Idle workers are completely stationary
} as const

// Coastline city position (passed from ZoneRenderer)
interface CityCoastlinePos {
  x: number
  z: number
}

export class WorkerRenderer {
  private scene: Scene
  private hexGrid: HexGrid
  private workers: Map<string, WorkerState> = new Map()
  private footprintTextureLeft: Texture | null = null
  private footprintTextureRight: Texture | null = null
  private cityCoastlinePositions: Map<string, CityCoastlinePos> = new Map()

  constructor(scene: Scene, hexGrid: HexGrid) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.loadFootprintTextures()
  }

  // Set coastline-computed city positions (called by ZoneRenderer)
  setCityCoastlinePositions(positions: Map<string, CityCoastlinePos>): void {
    this.cityCoastlinePositions = positions
  }

  /**
   * Load footprint sprite textures at startup
   */
  private loadFootprintTextures(): void {
    const loader = new TextureLoader()
    loader.load('/sprites/footprint-left.png', (texture) => {
      this.footprintTextureLeft = texture
    })
    loader.load('/sprites/footprint-right.png', (texture) => {
      this.footprintTextureRight = texture
    })
  }

  /**
   * Create a single footprint mesh using sprite textures
   * Sprites are 128x128, toes pointing up, rotated to match movement direction
   */
  private createFootprintMesh(isLeft: boolean, direction: number): Mesh {
    const texture = isLeft ? this.footprintTextureLeft : this.footprintTextureRight

    const worldSize = 0.5
    const geometry = new PlaneGeometry(worldSize, worldSize)
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: DoubleSide,
      depthWrite: false,
    })

    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    // Rotate to face movement direction (toes pointing forward along path)
    // Sprite has toes at top; direction is atan2(y, x) in world XZ plane
    mesh.rotation.z = -direction - Math.PI / 2
    return mesh
  }

  /**
   * Create handwritten-style worker label
   * Larger than city labels, ink-black, with golden glow when working
   */
  private createWorkerLabel(text: string, isWorking = false): Mesh {
    const maxChars = 16
    const displayText = text.length > maxChars
      ? text.slice(0, maxChars - 2) + '...'
      : text

    const fontSize = 64  // Large and readable
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    ctx.font = `italic 700 ${fontSize}px 'EB Garamond', Garamond, serif`
    const metrics = ctx.measureText(displayText)
    const textWidth = metrics.width

    const padding = fontSize * 1.0  // More padding for glow
    const width = textWidth + padding * 2
    const height = fontSize * 2.2

    const scale = 2
    canvas.width = width * scale
    canvas.height = height * scale
    ctx.scale(scale, scale)

    ctx.clearRect(0, 0, width, height)

    ctx.font = `italic 700 ${fontSize}px 'EB Garamond', Garamond, serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const cx = width / 2
    const cy = height / 2

    // Cream/vellum outline for legibility against any background
    ctx.strokeStyle = 'rgba(245, 238, 225, 0.95)'
    ctx.lineWidth = 4
    ctx.strokeText(displayText, cx, cy)

    // Ink-black text - always black, glow indicates working status
    ctx.fillStyle = '#1A1612'  // Dark ink black
    ctx.fillText(displayText, cx, cy)

    const texture = new CanvasTexture(canvas)
    // Larger world size for bigger labels
    const worldHeight = fontSize * 0.015  // Even bigger
    const aspectRatio = width / height
    const geometry = new PlaneGeometry(worldHeight * aspectRatio, worldHeight)
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    })

    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    // Store working status for animation
    mesh.userData.isWorking = isWorking
    mesh.userData.baseOpacity = 1.0
    return mesh
  }

  /**
   * Create worker group with all visual elements
   */
  private createWorkerGroup(session: Session, homePos: { x: number; z: number }): WorkerState {
    const group = new Group()

    // No position dot - label is sufficient
    const markerMesh = new Mesh()  // Placeholder for interface compatibility
    markerMesh.visible = false

    // Label IS the worker - no offset needed
    const isWorking = session.status === 'working'
    const labelMesh = this.createWorkerLabel(session.name, isWorking)
    labelMesh.position.y = 0.04
    group.add(labelMesh)

    // No activity decal - activity shown through label glow and movement speed
    const activityMesh = new Mesh()  // Placeholder for interface compatibility
    activityMesh.visible = false

    // Initial position - start at a random distance from city (not on top)
    const angle = Math.random() * Math.PI * 2
    const distance = SIMULATION.minDistanceFromCity + Math.random() * 1.5  // 1.0 to 2.5 units away
    const offsetX = Math.cos(angle) * distance
    const offsetZ = Math.sin(angle) * distance

    group.position.set(homePos.x + offsetX, 0, homePos.z + offsetZ)
    this.scene.add(group)

    const initialPos = new Vector2(homePos.x + offsetX, homePos.z + offsetZ)

    // Start with random heading pointing away from city
    const initialHeading = Math.random() * Math.PI * 2

    return {
      id: session.id,
      name: session.name,
      tmuxSession: session.tmuxSession,
      cityId: session.cityId,
      status: session.status,
      position: initialPos.clone(),
      velocity: new Vector2(0, 0),
      heading: initialHeading,
      targetHeading: initialHeading,
      homePosition: new Vector2(homePos.x, homePos.z),
      lastFootprintPos: initialPos.clone(),
      nextFootIsLeft: true,
      group,
      markerMesh,
      labelMesh,
      activityMesh,
      footprints: [],
    }
  }

  /**
   * Update worker state from session data
   */
  updateWorkers(sessions: Session[], cities: City[]): void {
    const cityMap = new Map(cities.map(c => [c.id, c]))
    const expectedIds = new Set<string>()

    for (const session of sessions) {
      if (!session.hex) continue

      expectedIds.add(session.id)

      // Get home position from coastline city position (preferred) or hex (fallback)
      let homePos: { x: number; z: number }
      if (session.cityId && this.cityCoastlinePositions.has(session.cityId)) {
        // Use coastline-computed position
        homePos = this.cityCoastlinePositions.get(session.cityId)!
      } else if (session.cityId && cityMap.has(session.cityId)) {
        const city = cityMap.get(session.cityId)!
        homePos = this.hexGrid.axialToCartesian(city.hex)
      } else {
        homePos = this.hexGrid.axialToCartesian(session.hex)
      }

      const existing = this.workers.get(session.id)

      if (existing) {
        // Check if status changed - need to update label glow
        const statusChanged = existing.status !== session.status

        existing.status = session.status
        existing.homePosition.set(homePos.x, homePos.z)

        // Refresh label if status changed (for working glow)
        if (statusChanged) {
          const isWorking = session.status === 'working'
          const oldLabel = existing.labelMesh

          // Create new label with updated glow state
          const newLabel = this.createWorkerLabel(existing.name, isWorking)
          newLabel.position.copy(oldLabel.position)
          newLabel.rotation.copy(oldLabel.rotation)

          existing.group.remove(oldLabel)
          existing.group.add(newLabel)
          existing.labelMesh = newLabel

          // When worker stops, keep last 2 footprints as standing position
          if (!isWorking && existing.footprints.length > 0) {
            // Remove all but last 2 footprints
            while (existing.footprints.length > 2) {
              const old = existing.footprints.shift()!
              this.scene.remove(old.mesh)
            }
            // Mark remaining as permanent (won't fade)
            for (const fp of existing.footprints) {
              fp.permanent = true
              // Reset opacity to full
              const material = fp.mesh.material as MeshBasicMaterial
              material.opacity = 0.7
            }
          }

          // When worker starts moving again, clear standing footprints
          if (isWorking) {
            for (const fp of existing.footprints) {
              if (fp.permanent) {
                this.scene.remove(fp.mesh)
              }
            }
            existing.footprints = existing.footprints.filter(fp => !fp.permanent)
          }
        }
      } else {
        // Create new worker
        const state = this.createWorkerGroup(session, homePos)
        this.workers.set(session.id, state)
      }
    }

    // Remove workers that no longer exist
    for (const [id, state] of this.workers) {
      if (!expectedIds.has(id)) {
        this.scene.remove(state.group)
        // Also remove footprints
        for (const fp of state.footprints) {
          this.scene.remove(fp.mesh)
        }
        this.workers.delete(id)
      }
    }
  }

  // Track time for periodic target heading updates
  private targetHeadingTimers: Map<string, number> = new Map()

  /**
   * Normalize angle to [-PI, PI] range
   */
  private normalizeAngle(angle: number): number {
    while (angle > Math.PI) angle -= Math.PI * 2
    while (angle < -Math.PI) angle += Math.PI * 2
    return angle
  }

  /**
   * Simulate steering and update positions
   * Call this every frame
   * ONLY working workers move - idle workers are stationary
   */
  simulate(deltaTime: number): void {
    const dt = Math.min(deltaTime, 0.05)  // Cap for stability

    // Collect all worker positions for avoidance
    const positions = Array.from(this.workers.values())
      .filter(w => w.status === 'working')
      .map(w => ({ id: w.id, pos: w.position }))

    for (const worker of this.workers.values()) {
      // IDLE WORKERS ARE STATIONARY - skip simulation entirely
      if (worker.status !== 'working') {
        worker.group.position.x = worker.position.x
        worker.group.position.z = worker.position.y
        continue
      }

      // Initialize timer if needed
      if (!this.targetHeadingTimers.has(worker.id)) {
        this.targetHeadingTimers.set(worker.id, 0)
      }

      // Update target heading timer
      let timer = this.targetHeadingTimers.get(worker.id)! + dt
      if (timer >= SIMULATION.targetHeadingInterval) {
        // Pick a new random target heading (biased toward current direction for smooth paths)
        const turnAmount = (Math.random() - 0.5) * Math.PI * 0.8  // ±72° max change
        worker.targetHeading = this.normalizeAngle(worker.heading + turnAmount)
        timer = 0
      }
      this.targetHeadingTimers.set(worker.id, timer)

      // Calculate steering corrections
      let steeringAdjustment = 0

      // 1. Steer toward home if too far out
      const toHome = new Vector2().copy(worker.homePosition).sub(worker.position)
      const distToHome = toHome.length()
      if (distToHome > SIMULATION.maxWanderRadius * 0.8) {
        const homeAngle = Math.atan2(toHome.y, toHome.x)
        const homeDiff = this.normalizeAngle(homeAngle - worker.heading)
        const urgency = (distToHome - SIMULATION.maxWanderRadius * 0.8) / (SIMULATION.maxWanderRadius * 0.2)
        steeringAdjustment += homeDiff * SIMULATION.homingStrength * Math.min(1, urgency)
      }

      // 2. Steer away from city center if too close
      if (distToHome < SIMULATION.minDistanceFromCity) {
        const awayAngle = Math.atan2(-toHome.y, -toHome.x)
        const awayDiff = this.normalizeAngle(awayAngle - worker.heading)
        steeringAdjustment += awayDiff * 0.5
      }

      // 3. Steer away from other workers
      for (const other of positions) {
        if (other.id === worker.id) continue
        const diff = new Vector2().copy(worker.position).sub(other.pos)
        const dist = diff.length()
        if (dist < SIMULATION.repulsionRadius && dist > 0.01) {
          const awayAngle = Math.atan2(diff.y, diff.x)
          const awayDiff = this.normalizeAngle(awayAngle - worker.heading)
          const strength = (1 - dist / SIMULATION.repulsionRadius) * SIMULATION.repulsionStrength
          steeringAdjustment += awayDiff * strength
        }
      }

      // 4. Steer toward target heading (base wandering behavior)
      const targetDiff = this.normalizeAngle(worker.targetHeading - worker.heading)
      steeringAdjustment += targetDiff * 0.3

      // Apply steering with turn rate limit (smooth curves, no u-turns)
      const maxTurn = SIMULATION.maxTurnRate * dt
      const actualTurn = Math.max(-maxTurn, Math.min(maxTurn, steeringAdjustment))
      worker.heading = this.normalizeAngle(worker.heading + actualTurn)

      // Move in heading direction at constant walk speed
      const moveX = Math.cos(worker.heading) * SIMULATION.walkSpeed * dt
      const moveY = Math.sin(worker.heading) * SIMULATION.walkSpeed * dt
      worker.position.x += moveX
      worker.position.y += moveY

      // Hard constraint: keep within max wander radius
      const homeOffset = new Vector2().copy(worker.position).sub(worker.homePosition)
      if (homeOffset.length() > SIMULATION.maxWanderRadius) {
        homeOffset.normalize().multiplyScalar(SIMULATION.maxWanderRadius)
        worker.position.copy(worker.homePosition).add(homeOffset)
      }

      // Update mesh position
      worker.group.position.x = worker.position.x
      worker.group.position.z = worker.position.y

      // Place footprints based on distance traveled
      const distFromLastFootprint = worker.position.distanceTo(worker.lastFootprintPos)
      const footprintSpacing = 0.5  // Larger spacing = slower, more deliberate steps

      if (distFromLastFootprint >= footprintSpacing) {
        if (!this.footprintTextureLeft || !this.footprintTextureRight) continue

        // Use heading for footprint direction (smooth, not jittery velocity)
        const footprint = this.createFootprintMesh(worker.nextFootIsLeft, worker.heading)

        // Offset left/right feet perpendicular to walking direction
        const sideOffset = 0.12  // Distance from center line
        const perpAngle = worker.heading + (worker.nextFootIsLeft ? -Math.PI / 2 : Math.PI / 2)
        const offsetX = Math.cos(perpAngle) * sideOffset
        const offsetY = Math.sin(perpAngle) * sideOffset

        footprint.position.set(
          worker.position.x + offsetX,
          0.015,
          worker.position.y + offsetY
        )
        this.scene.add(footprint)

        worker.footprints.push({
          mesh: footprint,
          age: 0,
          isLeft: worker.nextFootIsLeft,
          permanent: false,
        })

        worker.lastFootprintPos.copy(worker.position)
        worker.nextFootIsLeft = !worker.nextFootIsLeft

        // Limit max footprints
        const maxFootprints = 25
        while (worker.footprints.length > maxFootprints) {
          const old = worker.footprints.shift()!
          this.scene.remove(old.mesh)
        }
      }
    }
  }

  // Animation time accumulator for pulsing effects
  private animationTime = 0

  /**
   * Animation tick - fades footprints, pulses working worker labels
   */
  animate(deltaTime: number): void {
    const fadeRate = 0.15  // Opacity units per second (slower fade = longer trails)
    const dt = Math.min(deltaTime, 0.1)
    this.animationTime += dt

    for (const worker of this.workers.values()) {
      // Golden pulse for working workers
      if (worker.status === 'working') {
        // Gentle sine wave pulse (0.8 to 1.0 opacity range)
        const pulse = 0.9 + 0.1 * Math.sin(this.animationTime * 2.5)
        const material = worker.labelMesh.material as MeshBasicMaterial
        material.opacity = pulse
        // Add slight golden tint by adjusting color
        material.color.setRGB(
          1.0,
          0.95 + 0.05 * Math.sin(this.animationTime * 2.5),
          0.85 + 0.1 * Math.sin(this.animationTime * 2.5)
        )
      } else {
        // Idle workers: full opacity, neutral color
        const material = worker.labelMesh.material as MeshBasicMaterial
        material.opacity = 1.0
        material.color.setRGB(1.0, 1.0, 1.0)
      }

      // Age and fade footprints (skip permanent ones)
      for (let i = worker.footprints.length - 1; i >= 0; i--) {
        const fp = worker.footprints[i]

        // Permanent footprints don't fade (standing position when stopped)
        if (fp.permanent) continue

        fp.age += dt

        // Calculate opacity based on age (fade over ~4-5 seconds)
        const opacity = Math.max(0, 0.7 - fp.age * fadeRate)
        const material = fp.mesh.material as MeshBasicMaterial
        material.opacity = opacity

        // Remove fully faded footprints
        if (opacity <= 0) {
          this.scene.remove(fp.mesh)
          worker.footprints.splice(i, 1)
        }
      }
    }
  }

  /**
   * Update activity display for a worker
   * Activity now shown through label glow (working status) rather than decals
   */
  updateActivity(_tmuxSession: string, _activities: Activity[]): void {
    // Activity decals removed - activity is now indicated through:
    // 1. Label glow (golden when working)
    // 2. Movement speed (slower when working, focused)
    // Status changes are handled in updateWorkers()
  }

  /**
   * Find worker at world position (for click detection)
   * Label is at worker position, so just check distance with generous radius
   */
  getWorkerAtPosition(x: number, z: number, radius = 1.2): WorkerState | null {
    for (const worker of this.workers.values()) {
      const dx = worker.position.x - x
      const dz = worker.position.y - z  // Vector2 y -> world z
      if (dx * dx + dz * dz < radius * radius) {
        return worker
      }
    }
    return null
  }

  /**
   * Get session ID for a worker (for routing clicks)
   */
  getSessionIdForWorker(workerId: string): string | null {
    const worker = this.workers.get(workerId)
    return worker?.id ?? null
  }

  /**
   * Clear all workers
   */
  clear(): void {
    for (const state of this.workers.values()) {
      this.scene.remove(state.group)
      // Also remove footprints
      for (const fp of state.footprints) {
        this.scene.remove(fp.mesh)
      }
    }
    this.workers.clear()
  }

  /**
   * Get all worker label meshes for zoom-stable scaling
   */
  getLabelMeshes(): Mesh[] {
    return Array.from(this.workers.values()).map(w => w.labelMesh)
  }

  /**
   * Update label scales based on camera distance for zoom-stable text
   * @param cameraDistance - Distance from camera to ground plane
   * @param minScale - Minimum scale factor (prevents labels from getting too small)
   * @param maxScale - Maximum scale factor (prevents labels from getting too large)
   */
  updateLabelScales(cameraDistance: number, minScale = 0.6, maxScale = 3.0): void {
    // Reference distance where labels are at "natural" size
    const referenceDistance = 20

    // Scale PROPORTIONALLY with camera distance to compensate for perspective
    // When zoomed out (larger distance), labels need to be bigger
    let scale = cameraDistance / referenceDistance

    // Clamp to min/max bounds
    scale = Math.max(minScale, Math.min(maxScale, scale))

    for (const worker of this.workers.values()) {
      worker.labelMesh.scale.setScalar(scale)
    }
  }
}
