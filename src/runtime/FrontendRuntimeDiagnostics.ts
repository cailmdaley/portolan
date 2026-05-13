import type { WebGLRenderer } from 'three'
import type { ZoneRenderer } from '../render/ZoneRenderer'
import type { PlaygroundViewer } from '../ui/PlaygroundViewer'
import type { HexCoord } from '../state/types'
import type { getArtifactMediaCacheStats } from '../ui/ArtifactMedia'
import type { FrontendRenderLoopStats } from './FrontendAppRuntime'
import {
  getNativePortolanStatus,
  getRecentNativeWorkspaceWindows,
  refreshNativeWorkspaceWindow,
  restoreRecentNativeWorkspaceWindows,
  type NativePortolanStatus,
  type NativeWorkspaceWindowRecord,
} from './NativeBridge'

export type DebugRuntimeWindow = Window & {
  zoneRenderer: ZoneRenderer
  debugWebGL: () => void
  debugArtifactCaches: () => void
  getFrontendRuntimeDiagnostics: () => FrontendRuntimeDiagnostics
  debugNativePortolan: () => Promise<NativePortolanStatus | null>
  debugNativeWorkspaceWindows: () => Promise<NativeWorkspaceWindowRecord[] | null>
  refreshNativeWorkspaceWindow: () => Promise<boolean>
  restoreNativeWorkspaceWindows: () => Promise<string[] | null>
  debugRuntime: () => Promise<{
    frontend: FrontendRuntimeDiagnostics
    server: unknown | null
    native: NativePortolanStatus | null
  }>
}

export interface FrontendRuntimeDiagnostics {
  timestamp: string
  runtimeDisposed: boolean
  ws: {
    state: 'missing' | 'connecting' | 'open' | 'closing' | 'closed'
    hasReconnectTimeout: boolean
    hasReceivedInitialState: boolean
  }
  world: {
    cityCount: number
    sessionCount: number
    originCount: number
    selectedHex: HexCoord | null
  }
  activity: {
    streamCount: number
    bufferedEventCount: number
    maxBufferedEventsPerStream: number
    maxPerStreamLimit: number
    totalEventsReceived: number
    recentEventsPerMinute: number
    streamWithMostEvents: string | null
  }
  hud: {
    hasPendingWorkerUpdateFrame: boolean
    totalWorkerHudUpdates: number
  }
  renderLoop: FrontendRenderLoopStats
  renderer: ReturnType<ZoneRenderer['getRuntimeStats']>
  webgl: {
    geometries: number
    textures: number
    drawCalls: number
    triangles: number
    points: number
    lines: number
  }
  artifactMediaCaches: ReturnType<typeof getArtifactMediaCacheStats>
  views: {
    /** Stage I — the CityHUD overlay retired, so its `getRuntimeStats()`
     *  contribution went with it. Kept the wrapper struct (and the
     *  `playground` field inside) so consumers reading `views.*` keep
     *  finding what they expect rather than getting an undefined. */
    playground: ReturnType<PlaygroundViewer['getRuntimeStats']>
  }
}

interface ActivityBufferStats {
  streamCount: number
  bufferedEventCount: number
  maxBufferedEventsPerStream: number
  streamWithMostEvents: string | null
}

interface InstallFrontendRuntimeDiagnosticsOptions {
  renderer: WebGLRenderer
  zoneRenderer: ZoneRenderer
  playgroundViewer: PlaygroundViewer
  getArtifactMediaCacheStats: () => ReturnType<typeof getArtifactMediaCacheStats>
  getRuntimeDisposed: () => boolean
  getWebSocketState: () => 'missing' | 'connecting' | 'open' | 'closing' | 'closed'
  hasReconnectTimeout: () => boolean
  hasReceivedInitialState: () => boolean
  getWorldStats: () => {
    cityCount: number
    sessionCount: number
    originCount: number
    selectedHex: HexCoord | null
  }
  getActivityStats: () => {
    stats: ActivityBufferStats
    maxPerStreamLimit: number
    totalEventsReceived: number
    recentEventsPerMinute: number
  }
  getHudStats: () => {
    hasPendingWorkerUpdateFrame: boolean
    totalWorkerHudUpdates: number
  }
  getRenderLoopStats: () => FrontendRenderLoopStats
}

export function installFrontendRuntimeDiagnostics(
  options: InstallFrontendRuntimeDiagnosticsOptions
): DebugRuntimeWindow {
  const debugWindow = window as unknown as DebugRuntimeWindow
  debugWindow.zoneRenderer = options.zoneRenderer
  debugWindow.debugWebGL = () => {
    const info = options.renderer.info
    console.table({
      'Geometries (GPU)': info.memory.geometries,
      'Textures (GPU)': info.memory.textures,
      'Draw calls': info.render.calls,
      'Triangles': info.render.triangles,
      'Points': info.render.points,
      'Lines': info.render.lines,
    })
  }
  debugWindow.debugArtifactCaches = () => {
    console.table(options.getArtifactMediaCacheStats())
  }
  debugWindow.debugNativePortolan = async () => {
    const native = await getNativePortolanStatus()
    console.log('[debugNativePortolan] snapshot', native)
    return native
  }
  debugWindow.debugNativeWorkspaceWindows = async () => {
    const windows = await getRecentNativeWorkspaceWindows()
    console.log('[debugNativeWorkspaceWindows] snapshot', windows)
    return windows
  }
  debugWindow.refreshNativeWorkspaceWindow = refreshNativeWorkspaceWindow
  debugWindow.restoreNativeWorkspaceWindows = restoreRecentNativeWorkspaceWindows
  debugWindow.getFrontendRuntimeDiagnostics = () => {
    const activity = options.getActivityStats()
    const webglInfo = options.renderer.info
    const world = options.getWorldStats()
    const hud = options.getHudStats()
    const renderLoop = options.getRenderLoopStats()

    return {
      timestamp: new Date().toISOString(),
      runtimeDisposed: options.getRuntimeDisposed(),
      ws: {
        state: options.getWebSocketState(),
        hasReconnectTimeout: options.hasReconnectTimeout(),
        hasReceivedInitialState: options.hasReceivedInitialState(),
      },
      world,
      activity: {
        streamCount: activity.stats.streamCount,
        bufferedEventCount: activity.stats.bufferedEventCount,
        maxBufferedEventsPerStream: activity.stats.maxBufferedEventsPerStream,
        maxPerStreamLimit: activity.maxPerStreamLimit,
        totalEventsReceived: activity.totalEventsReceived,
        recentEventsPerMinute: activity.recentEventsPerMinute,
        streamWithMostEvents: activity.stats.streamWithMostEvents,
      },
      hud,
      renderLoop,
      renderer: options.zoneRenderer.getRuntimeStats(),
      webgl: {
        geometries: webglInfo.memory.geometries,
        textures: webglInfo.memory.textures,
        drawCalls: webglInfo.render.calls,
        triangles: webglInfo.render.triangles,
        points: webglInfo.render.points,
        lines: webglInfo.render.lines,
      },
      artifactMediaCaches: options.getArtifactMediaCacheStats(),
      views: {
        playground: options.playgroundViewer.getRuntimeStats(),
      },
    }
  }
  debugWindow.debugRuntime = async () => {
    const frontend = debugWindow.getFrontendRuntimeDiagnostics()
    let server: unknown | null = null
    let native: NativePortolanStatus | null = null

    try {
      const res = await fetch(`http://${window.location.hostname}:4004/debug-runtime`)
      if (!res.ok) {
        const body = await res.text()
        throw new Error(body || `HTTP ${res.status}`)
      }
      server = await res.json()
    } catch (error) {
      console.warn('[debugRuntime] Failed to fetch /debug-runtime:', error)
    }

    try {
      native = await getNativePortolanStatus()
    } catch (error) {
      console.warn('[debugRuntime] Failed to fetch native status:', error)
    }

    const snapshot = { frontend, server, native }
    console.log('[debugRuntime] snapshot', snapshot)
    return snapshot
  }

  return debugWindow
}
