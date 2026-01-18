// Camera.ts - Perspective camera with pan/zoom controls

import { PerspectiveCamera, Vector3 } from 'three'
import type { CartesianCoord } from '../state/types'

export class Camera {
  camera: PerspectiveCamera
  private canvas: HTMLCanvasElement

  // Camera state - target point we're looking at
  private target = new Vector3(0, 0, 0)
  private distance = 15
  private angle = Math.PI / 4  // 45° from horizontal
  private rotation = Math.PI / 4  // 45° around Y axis (diagonal view)

  // Zoom limits
  private minDistance = 5
  private maxDistance = 100

  // Pan state
  private isDragging = false
  private wasDrag = false // Set true if mouse moved significantly during drag
  private dragStart = { x: 0, y: 0 }
  private dragAnchor: CartesianCoord | null = null // World point to keep under mouse
  private readonly dragThreshold = 5 // pixels

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    // Create perspective camera
    const aspect = canvas.clientWidth / canvas.clientHeight
    this.camera = new PerspectiveCamera(50, aspect, 0.1, 1000)

    this.setupControls()
    this.updateCamera()
  }

  private setupControls(): void {
    // Mouse drag for pan (sieve behavior)
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { // Left click
        this.isDragging = true
        this.wasDrag = false
        this.dragStart = { x: e.clientX, y: e.clientY }
        // Store the world point under the mouse — this stays fixed during drag
        this.dragAnchor = this.screenToWorld(e.clientX, e.clientY)
      }
    })

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.dragAnchor) return

      // Check if we've moved enough from start to count as a drag
      const totalDx = e.clientX - this.dragStart.x
      const totalDy = e.clientY - this.dragStart.y
      if (Math.abs(totalDx) > this.dragThreshold || Math.abs(totalDy) > this.dragThreshold) {
        this.wasDrag = true
      }

      // Sieve: keep the anchor world point under the mouse
      // 1. Where does the mouse currently point in world space?
      const currentWorld = this.screenToWorld(e.clientX, e.clientY)
      // 2. Move target so anchor stays under mouse
      this.target.x += this.dragAnchor.x - currentWorld.x
      this.target.z += this.dragAnchor.z - currentWorld.z
      this.updateCamera()
    })

    window.addEventListener('mouseup', () => {
      this.isDragging = false
      this.dragAnchor = null
      // wasDrag is kept until click handler checks it
    })

    // Reset wasDrag after click has had a chance to check it
    this.canvas.addEventListener('click', () => {
      // Use setTimeout to reset after current click event fully processes
      setTimeout(() => { this.wasDrag = false }, 0)
    })

    // Scroll wheel for zoom
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 1.1 : 0.9
      this.zoomBy(delta)
    }, { passive: false })

    // Arrow keys for navigation
    window.addEventListener('keydown', (e) => {
      const step = 1.5
      switch (e.key) {
        case 'ArrowUp':
          this.pan(0, step)
          e.preventDefault()
          break
        case 'ArrowDown':
          this.pan(0, -step)
          e.preventDefault()
          break
        case 'ArrowLeft':
          this.pan(-step, 0)
          e.preventDefault()
          break
        case 'ArrowRight':
          this.pan(step, 0)
          e.preventDefault()
          break
      }
    })
  }

  pan(screenDx: number, screenDy: number): void {
    // Camera looks from position toward target.
    // For 45° rotation: camera is at (+X, +Z) relative to target, looking toward (-X, -Z)
    //
    // Screen right → camera's right vector in world XZ
    // Screen up → camera's forward vector in world XZ (toward what you're looking at)
    //
    // With rotation = π/4:
    //   right  = (cos(rotation), -sin(rotation)) in XZ = (0.707, -0.707)
    //   forward = (-sin(rotation), -cos(rotation)) in XZ = (-0.707, -0.707)
    //
    // But we want sieve: drag right = target moves right = view shifts left
    // So screen movement directly moves target in camera-relative directions.

    const cosR = Math.cos(this.rotation)
    const sinR = Math.sin(this.rotation)

    // Right vector (screen X → world XZ)
    const rightX = cosR
    const rightZ = -sinR

    // Forward vector (screen Y → world XZ, "into" the screen)
    const forwardX = -sinR
    const forwardZ = -cosR

    // Move target: positive screenDx = drag right = target moves right
    this.target.x += screenDx * rightX + screenDy * forwardX
    this.target.z += screenDx * rightZ + screenDy * forwardZ
    this.updateCamera()
  }

  zoomBy(factor: number): void {
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance * factor))
    this.updateCamera()
  }

  focusOn(pos: CartesianCoord): void {
    this.target.x = pos.x
    this.target.z = pos.z
    this.updateCamera()
  }

  private updateCamera(): void {
    // Position camera at distance from target, at angle
    const y = this.distance * Math.sin(this.angle)
    const horizontal = this.distance * Math.cos(this.angle)
    const x = this.target.x + horizontal * Math.sin(this.rotation)
    const z = this.target.z + horizontal * Math.cos(this.rotation)

    this.camera.position.set(x, y, z)
    this.camera.lookAt(this.target)

    this.camera.updateProjectionMatrix()
  }

  /**
   * Convert screen coordinates to world coordinates (on Y=0 plane)
   */
  screenToWorld(screenX: number, screenY: number): CartesianCoord {
    const rect = this.canvas.getBoundingClientRect()

    // Normalize to -1 to 1
    const nx = ((screenX - rect.left) / rect.width) * 2 - 1
    const ny = -((screenY - rect.top) / rect.height) * 2 + 1

    // Create ray from camera through screen point
    const rayOrigin = this.camera.position.clone()
    const rayDir = new Vector3(nx, ny, 0.5)
      .unproject(this.camera)
      .sub(rayOrigin)
      .normalize()

    // Intersect with Y=0 plane
    if (Math.abs(rayDir.y) < 0.0001) {
      // Ray parallel to ground, return target
      return { x: this.target.x, z: this.target.z }
    }

    const t = -rayOrigin.y / rayDir.y
    const x = rayOrigin.x + rayDir.x * t
    const z = rayOrigin.z + rayDir.z * t

    return { x, z }
  }

  /**
   * Handle window resize
   */
  resize(): void {
    const aspect = this.canvas.clientWidth / this.canvas.clientHeight
    this.camera.aspect = aspect
    this.updateCamera()
  }

  /**
   * Check if user just completed a drag (to prevent click events during pan)
   */
  get dragging(): boolean {
    return this.wasDrag
  }
}
