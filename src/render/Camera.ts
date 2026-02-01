// Camera.ts - Orthographic camera with pan/zoom controls (isometric-style)

import { OrthographicCamera, Vector3 } from 'three'
import type { CartesianCoord } from '../state/types'

// Safari-specific gesture event (pinch-to-zoom)
interface GestureEvent extends Event {
  scale: number
  rotation: number
}

export class Camera {
  camera: OrthographicCamera
  private canvas: HTMLCanvasElement
  private eventTarget: HTMLElement  // May be overlay for Safari compatibility

  // Camera state - target point we're looking at
  private target = new Vector3(0, 0, 0)
  private zoom = 30  // View half-width in world units (smaller = more zoomed in)
  private angle = Math.PI / 4  // 45° from horizontal (matches sprite perspective)
  private rotation = 0  // 0° around Y axis (straight-on view)

  // Zoom limits
  private minZoom = 5
  private maxZoom = 100

  // Pan state
  private isDragging = false
  private wasDrag = false // Set true if mouse moved significantly during drag
  private dragStart = { x: 0, y: 0 }
  private dragAnchor: CartesianCoord | null = null // World point to keep under mouse
  private readonly dragThreshold = 5 // pixels

  constructor(canvas: HTMLCanvasElement, eventTarget?: HTMLElement) {
    this.canvas = canvas
    this.eventTarget = eventTarget || canvas

    // Create orthographic camera (isometric-style, no perspective distortion)
    const aspect = canvas.clientWidth / canvas.clientHeight
    this.camera = new OrthographicCamera(
      -this.zoom * aspect, this.zoom * aspect,  // left, right
      this.zoom, -this.zoom,                     // top, bottom
      0.1, 1000                                  // near, far
    )

    this.setupControls()
    this.updateCamera()
  }

  private setupControls(): void {
    // Mouse drag for pan (sieve behavior)
    this.eventTarget.addEventListener('mousedown', (e) => {
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
    this.eventTarget.addEventListener('click', () => {
      // Use setTimeout to reset after current click event fully processes
      setTimeout(() => { this.wasDrag = false }, 0)
    })

    // Scroll wheel for zoom
    this.eventTarget.addEventListener('wheel', (e) => {
      // Don't capture wheel events over panels - let them scroll
      const target = e.target as HTMLElement
      if (target.closest('#worker-panel') || target.closest('#city-panel')) {
        return // Let panel handle scroll
      }
      e.preventDefault()
      e.stopPropagation()
      const delta = e.deltaY > 0 ? 1.05 : 0.95  // Slower zoom
      this.zoomBy(delta)
    }, { passive: false })

    // Safari pinch-to-zoom (gesture events)
    let lastScale = 1
    this.eventTarget.addEventListener('gesturestart', (e) => {
      e.preventDefault()
      lastScale = 1
    })
    this.eventTarget.addEventListener('gesturechange', (e: Event) => {
      e.preventDefault()
      const ge = e as GestureEvent
      const scaleDelta = ge.scale / lastScale
      lastScale = ge.scale
      // Invert: scale > 1 means pinch out = zoom in = smaller distance
      this.zoomBy(1 / scaleDelta)
    })
    this.eventTarget.addEventListener('gestureend', (e) => {
      e.preventDefault()
    })

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
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor))
    this.updateCamera()
  }

  focusOn(pos: CartesianCoord): void {
    this.target.x = pos.x
    this.target.z = pos.z
    this.updateCamera()
  }

  private updateCamera(): void {
    // Update orthographic bounds based on zoom
    const aspect = this.canvas.clientWidth / this.canvas.clientHeight
    this.camera.left = -this.zoom * aspect
    this.camera.right = this.zoom * aspect
    this.camera.top = this.zoom
    this.camera.bottom = -this.zoom

    // Position camera looking at target from angle
    // Distance is arbitrary for ortho, just needs to be far enough
    const distance = 100
    const y = distance * Math.sin(this.angle)
    const horizontal = distance * Math.cos(this.angle)
    const x = this.target.x + horizontal * Math.sin(this.rotation)
    const z = this.target.z + horizontal * Math.cos(this.rotation)

    this.camera.position.set(x, y, z)
    this.camera.lookAt(this.target)

    this.camera.updateProjectionMatrix()
  }

  /**
   * Convert screen coordinates to world coordinates (on Y=0 plane)
   * For orthographic camera, this is a simple linear mapping
   */
  screenToWorld(screenX: number, screenY: number): CartesianCoord {
    const rect = this.canvas.getBoundingClientRect()
    const aspect = rect.width / rect.height

    // Normalize to -1 to 1
    const nx = ((screenX - rect.left) / rect.width) * 2 - 1
    const ny = -((screenY - rect.top) / rect.height) * 2 + 1

    // For orthographic: screen coords map directly to camera-relative world coords
    // nx maps to camera right direction, ny maps to camera up direction
    const camRight = this.zoom * aspect * nx
    const camUp = this.zoom * ny

    // Convert camera-relative to world coords
    // Camera looks from south at angle, so:
    // - camera right = world X (roughly, depends on rotation)
    // - camera up = mix of world Y and Z (depends on angle)
    const cosAngle = Math.cos(this.angle)
    const sinAngle = Math.sin(this.angle)
    const cosRot = Math.cos(this.rotation)
    const sinRot = Math.sin(this.rotation)

    // Camera right vector (in XZ plane)
    const rightX = cosRot
    const rightZ = -sinRot

    // Camera forward vector projected onto XZ plane (screen up moves you "forward")
    const forwardX = -sinRot * cosAngle
    const forwardZ = -cosRot * cosAngle

    const x = this.target.x + camRight * rightX + camUp * forwardX
    const z = this.target.z + camRight * rightZ + camUp * forwardZ

    return { x, z }
  }

  /**
   * Handle window resize
   */
  resize(): void {
    this.updateCamera()  // Ortho bounds updated in updateCamera
  }

  /**
   * Check if user just completed a drag (to prevent click events during pan)
   */
  get dragging(): boolean {
    return this.wasDrag
  }

  /**
   * Get current zoom level for zoom-aware label scaling
   */
  get cameraDistance(): number {
    return this.zoom  // Higher = more zoomed out
  }
}
