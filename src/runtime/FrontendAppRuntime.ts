import type { Scene, WebGLRenderer } from 'three'
import type { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Camera } from '../render/Camera'
import type { ZoneRenderer } from '../render/ZoneRenderer'
import type { FrontendStateSync } from './FrontendStateSync'
import type { MapInteractionController } from '../MapInteractionController'
import type { ContextMenu } from '../ui/ContextMenu'
import type { NewWorkerDialog } from '../ui/NewWorkerDialog'
import type { PlaygroundViewer } from '../ui/PlaygroundViewer'
import type { City, Session } from '../state/types'
import { getPageAttention, UNFOCUSED_VISIBLE_FRAME_MS } from './PageAttention'

interface FrontendAppRuntimeOptions {
  renderer: WebGLRenderer
  scene: Scene
  labelRenderer: CSS2DRenderer
  camera: Camera
  zoneRenderer: ZoneRenderer
  stateSync: FrontendStateSync
  mapInteractions: MapInteractionController
  contextMenu: ContextMenu
  newWorkerDialog: NewWorkerDialog
  playgroundViewer: PlaygroundViewer
  clearArtifactMediaCaches: () => void
  getCities: () => City[]
  /** Re-render the workers surface — Stage I retired the CityHUD; the
   *  surviving consumer is the chrome bar's worker-bird strip. Kept as a
   *  hook because activity-event scheduling lives here. */
  updateWorkerHud: () => void
  /** Whether the workers surface should be redrawn at all. Stage I — the
   *  chrome bar is always visible, so this is effectively `() => true`;
   *  kept for symmetry with the pre-Stage-I HUD-visibility gate, which a
   *  future on-demand-render strategy could re-introduce. */
  isWorkerHudVisible: () => boolean
  applyMockState: (cities: City[], sessions: Session[]) => void
  /** Optional per-frame hook, called after scene render. Useful for DOM
   *  overlays that need to track world-anchored points through camera changes
   *  (e.g. pin hover tooltip re-anchoring during pan/zoom). */
  onFrame?: () => void
}

export class FrontendAppRuntime {
  private readonly options: FrontendAppRuntimeOptions
  private runtimeDisposed = false
  private animationFrameId: number | null = null
  private unfocusedFrameTimeoutId: number | null = null
  private mockDataTimeout: ReturnType<typeof setTimeout> | null = null
  private workerHudUpdateFrameId: number | null = null
  private hasRuntimeCleanupRun = false
  private totalWorkerHudUpdates = 0

  constructor(options: FrontendAppRuntimeOptions) {
    this.options = options
  }

  start(): void {
    window.addEventListener('resize', this.onResize)
    // Pause the render loop when the page is hidden (background tab,
    // minimized window). `visibilitychange` fires on document; the handler
    // restarts the loop when the page returns to the foreground.
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    // A tiled but unfocused window is still visible, so Page Visibility does
    // not fire. Resume the full-rate RAF loop immediately when focus returns.
    window.addEventListener('focus', this.onWindowFocus)
    this.animate()
    this.scheduleMockDataFallback()
  }

  dispose(): void {
    if (this.hasRuntimeCleanupRun) return
    this.hasRuntimeCleanupRun = true
    this.runtimeDisposed = true

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
    if (this.unfocusedFrameTimeoutId !== null) {
      window.clearTimeout(this.unfocusedFrameTimeoutId)
      this.unfocusedFrameTimeoutId = null
    }
    if (this.mockDataTimeout) {
      clearTimeout(this.mockDataTimeout)
      this.mockDataTimeout = null
    }
    if (this.workerHudUpdateFrameId !== null) {
      cancelAnimationFrame(this.workerHudUpdateFrameId)
      this.workerHudUpdateFrameId = null
    }

    this.options.stateSync.dispose()

    this.options.mapInteractions.dispose()
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('focus', this.onWindowFocus)

    this.options.contextMenu.dispose()
    this.options.newWorkerDialog.dispose()
    this.options.playgroundViewer.dispose()

    this.options.camera.dispose()
    this.options.zoneRenderer.dispose()
    this.options.renderer.dispose()

    this.options.clearArtifactMediaCaches()
    this.options.labelRenderer.domElement.remove()
  }

  scheduleWorkerHudUpdate(): void {
    if (!this.options.isWorkerHudVisible() || this.workerHudUpdateFrameId !== null) return

    this.workerHudUpdateFrameId = requestAnimationFrame(() => {
      this.workerHudUpdateFrameId = null
      if (this.runtimeDisposed) return
      this.totalWorkerHudUpdates += 1
      this.options.updateWorkerHud()
    })
  }

  isDisposed(): boolean {
    return this.runtimeDisposed
  }

  getHudStats(): { hasPendingWorkerUpdateFrame: boolean; totalWorkerHudUpdates: number } {
    return {
      hasPendingWorkerUpdateFrame: this.workerHudUpdateFrameId !== null,
      totalWorkerHudUpdates: this.totalWorkerHudUpdates,
    }
  }

  private readonly onResize = (): void => {
    this.options.renderer.setSize(window.innerWidth, window.innerHeight)
    this.options.labelRenderer.setSize(window.innerWidth, window.innerHeight)
    this.options.camera.resize()
  }

  /** Restart the render loop when the page returns to the foreground. */
  private readonly onVisibilityChange = (): void => {
    if (this.runtimeDisposed) return
    if (document.hidden) {
      this.clearUnfocusedFrameTimeout()
      return
    }
    if (!this.hasScheduledFrame()) {
      this.animate()
    }
  }

  private readonly onWindowFocus = (): void => {
    if (this.runtimeDisposed || document.hidden) return
    if (this.unfocusedFrameTimeoutId !== null) {
      this.clearUnfocusedFrameTimeout()
      if (this.animationFrameId === null) {
        this.animationFrameId = requestAnimationFrame(this.animate)
      }
    }
  }

  private readonly animate = (): void => {
    if (this.runtimeDisposed) return
    this.animationFrameId = null

    // Pause when the page is hidden — no visible output to produce and
    // browsers already throttle RAF on hidden pages. Setting animationFrameId
    // to null signals the paused state so onVisibilityChange can restart.
    if (getPageAttention() === 'hidden') {
      return
    }

    this.options.zoneRenderer.animate(this.options.camera.cameraDistance)
    this.options.renderer.render(this.options.scene, this.options.camera.camera)
    this.options.labelRenderer.render(this.options.scene, this.options.camera.camera)
    this.options.onFrame?.()
    this.scheduleNextFrame()
  }

  private scheduleNextFrame(): void {
    if (this.runtimeDisposed || document.hidden) return
    if (getPageAttention() === 'visible-unfocused') {
      this.unfocusedFrameTimeoutId = window.setTimeout(() => {
        this.unfocusedFrameTimeoutId = null
        if (this.runtimeDisposed || document.hidden) return
        this.animationFrameId = requestAnimationFrame(this.animate)
      }, UNFOCUSED_VISIBLE_FRAME_MS)
      return
    }
    this.animationFrameId = requestAnimationFrame(this.animate)
  }

  private hasScheduledFrame(): boolean {
    return this.animationFrameId !== null || this.unfocusedFrameTimeoutId !== null
  }

  private clearUnfocusedFrameTimeout(): void {
    if (this.unfocusedFrameTimeoutId === null) return
    window.clearTimeout(this.unfocusedFrameTimeoutId)
    this.unfocusedFrameTimeoutId = null
  }

  private scheduleMockDataFallback(): void {
    this.mockDataTimeout = setTimeout(() => {
      if (this.options.getCities().length === 0) {
        this.options.applyMockState(
          [
            { id: '1', name: 'portolan-v2', path: '/projects/portolan-v2', hex: { q: 0, r: 0 }, fiberCount: 3, hasClaims: false, hasPlaygrounds: true, isDormant: false, originId: 'local' },
            { id: '2', name: 'loom', path: '/projects/loom', hex: { q: 2, r: -1 }, fiberCount: 7, hasClaims: true, hasPlaygrounds: false, isDormant: false, originId: 'local' },
            { id: '3', name: 'pure-eb', path: '/projects/pure-eb', hex: { q: -2, r: 1 }, fiberCount: 0, hasClaims: true, hasPlaygrounds: false, isDormant: true, originId: 'remote-candide' },
          ],
          [
            { id: 's1', name: 'claude-0', tmuxSession: 'mock-0', cityId: '1', hex: { q: 1, r: 0 }, status: 'working', originId: 'local', lastActivity: Date.now() },
            { id: 's2', name: 'claude-1', tmuxSession: 'mock-1', cityId: '1', hex: { q: 0, r: 1 }, status: 'idle', originId: 'local', lastActivity: Date.now() },
            { id: 's3', name: 'claude-2', tmuxSession: 'mock-2', cityId: '2', hex: { q: 3, r: -1 }, status: 'idle', originId: 'local', lastActivity: Date.now() },
          ],
        )
      }
      this.mockDataTimeout = null
    }, 1000)
  }
}
