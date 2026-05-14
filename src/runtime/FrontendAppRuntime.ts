import type { Scene, WebGLRenderer } from 'three'
import type { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Camera } from '../render/Camera'
import type { ZoneRenderer } from '../render/ZoneRenderer'
import type { FrontendStateSync } from './FrontendStateSync'
import type { MapInteractionController } from '../MapInteractionController'
import type { ContextMenu } from '../ui/ContextMenu'
import type { NewWorkerDialog } from '../ui/NewWorkerDialog'
import type { PlaygroundViewer } from '../ui/PlaygroundViewer'
import type { City } from '../state/types'
import {
  getPageAttention,
  type PageAttentionState,
  UNFOCUSED_VISIBLE_FRAME_MS,
} from './PageAttention'

const RENDER_LOOP_STATS_WINDOW_MS = 5_000

type VisiblePageAttentionState = Exclude<PageAttentionState, 'hidden'>
type ScheduledRenderWork = 'raf' | 'timeout' | 'paused'

export interface FrontendRenderLoopStats {
  attention: PageAttentionState
  scheduledWork: ScheduledRenderWork
  totalFrames: number
  activeFrames: number
  visibleUnfocusedFrames: number
  hiddenSkips: number
  lastRenderAtMs: number | null
  lastFrameIntervalMs: number | null
  recentFrameCount: number
  recentWindowMs: number
  approximateFps: number
}

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
  private workerHudUpdateFrameId: number | null = null
  private hasRuntimeCleanupRun = false
  private totalWorkerHudUpdates = 0
  private totalFrames = 0
  private activeFrames = 0
  private visibleUnfocusedFrames = 0
  private hiddenSkips = 0
  private lastRenderAtMs: number | null = null
  private lastFrameIntervalMs: number | null = null
  private recentRenderTimesMs: number[] = []

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

  getRenderLoopStats(): FrontendRenderLoopStats {
    const nowMs = performance.now()
    this.pruneRecentRenderTimes(nowMs)
    const recentWindowMs = this.recentRenderTimesMs.length > 1
      ? this.recentRenderTimesMs[this.recentRenderTimesMs.length - 1] - this.recentRenderTimesMs[0]
      : 0
    return {
      attention: getPageAttention(),
      scheduledWork: this.getScheduledRenderWork(),
      totalFrames: this.totalFrames,
      activeFrames: this.activeFrames,
      visibleUnfocusedFrames: this.visibleUnfocusedFrames,
      hiddenSkips: this.hiddenSkips,
      lastRenderAtMs: this.lastRenderAtMs,
      lastFrameIntervalMs: this.lastFrameIntervalMs,
      recentFrameCount: this.recentRenderTimesMs.length,
      recentWindowMs,
      approximateFps: recentWindowMs > 0
        ? ((this.recentRenderTimesMs.length - 1) * 1000) / recentWindowMs
        : 0,
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

    const attention = getPageAttention()
    // Pause when the page is hidden — no visible output to produce and
    // browsers already throttle RAF on hidden pages. Setting animationFrameId
    // to null signals the paused state so onVisibilityChange can restart.
    if (attention === 'hidden') {
      this.hiddenSkips += 1
      return
    }

    this.recordRenderedFrame(attention)
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

  private recordRenderedFrame(attention: VisiblePageAttentionState): void {
    const nowMs = performance.now()
    this.totalFrames += 1
    if (attention === 'active') {
      this.activeFrames += 1
    } else {
      this.visibleUnfocusedFrames += 1
    }
    this.lastFrameIntervalMs = this.lastRenderAtMs === null ? null : nowMs - this.lastRenderAtMs
    this.lastRenderAtMs = nowMs
    this.recentRenderTimesMs.push(nowMs)
    this.pruneRecentRenderTimes(nowMs)
  }

  private pruneRecentRenderTimes(nowMs: number): void {
    const cutoffMs = nowMs - RENDER_LOOP_STATS_WINDOW_MS
    while (this.recentRenderTimesMs.length > 0 && this.recentRenderTimesMs[0] < cutoffMs) {
      this.recentRenderTimesMs.shift()
    }
  }

  private getScheduledRenderWork(): ScheduledRenderWork {
    if (this.animationFrameId !== null) return 'raf'
    if (this.unfocusedFrameTimeoutId !== null) return 'timeout'
    return 'paused'
  }

}
