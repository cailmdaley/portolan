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
    nativeLifecycle: NativeLifecycleDiagnostics
  }>
}

export type NativeLifecycleDiagnosticStatus =
  | 'browser'
  | 'unavailable'
  | 'matched'
  | 'missing-server-native-backend'
  | 'owner-mismatch'
  | 'drift'

export interface NativeLifecycleDiagnostics {
  status: NativeLifecycleDiagnosticStatus
  backendOwner: NativePortolanStatus['backend']['owner'] | null
  serverNativeBackend: unknown | null
  mismatches: string[]
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

interface ServerNativeBackendDiagnostics {
  enabled?: unknown
  backendRoot?: unknown
  resourceDir?: unknown
  launchKind?: unknown
  processGroup?: unknown
}

function readServerNativeBackend(server: unknown): ServerNativeBackendDiagnostics | null {
  if (typeof server !== 'object' || server === null || Array.isArray(server)) return null
  const runtime = (server as { runtime?: unknown }).runtime
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) return null
  const nativeBackend = (runtime as { nativeBackend?: unknown }).nativeBackend
  if (typeof nativeBackend !== 'object' || nativeBackend === null || Array.isArray(nativeBackend)) return null
  return nativeBackend as ServerNativeBackendDiagnostics
}

export function compareNativeLifecycleDiagnostics(
  server: unknown | null,
  native: NativePortolanStatus | null,
): NativeLifecycleDiagnostics {
  const serverNativeBackend = readServerNativeBackend(server)
  if (!native) {
    return {
      status: serverNativeBackend ? 'unavailable' : 'browser',
      backendOwner: null,
      serverNativeBackend,
      mismatches: serverNativeBackend
        ? ['server reports a native-owned backend, but the frontend is not running in Tauri']
        : [],
    }
  }

  if (native.backend.owner === 'external') {
    return {
      status: serverNativeBackend ? 'owner-mismatch' : 'matched',
      backendOwner: native.backend.owner,
      serverNativeBackend,
      mismatches: serverNativeBackend
        ? ['native_status reports an external backend, but /debug-runtime reports PORTOLAN_NATIVE=1']
        : [],
    }
  }

  if (!serverNativeBackend) {
    return {
      status: 'missing-server-native-backend',
      backendOwner: native.backend.owner,
      serverNativeBackend: null,
      mismatches: [`native_status reports a ${native.backend.owner} backend, but /debug-runtime has no nativeBackend block`],
    }
  }

  const mismatches = [
    serverNativeBackend.launchKind !== undefined && serverNativeBackend.launchKind !== native.backend.launchKind
      ? `launchKind differs: native_status=${native.backend.launchKind} debug-runtime=${String(serverNativeBackend.launchKind)}`
      : null,
    serverNativeBackend.backendRoot !== undefined && serverNativeBackend.backendRoot !== native.backend.cwd
      ? `backendRoot differs: native_status.cwd=${native.backend.cwd} debug-runtime=${String(serverNativeBackend.backendRoot)}`
      : null,
    serverNativeBackend.resourceDir !== undefined && serverNativeBackend.resourceDir !== native.backend.resourceDir
      ? `resourceDir differs: native_status=${String(native.backend.resourceDir)} debug-runtime=${String(serverNativeBackend.resourceDir)}`
      : null,
    serverNativeBackend.processGroup !== undefined && serverNativeBackend.processGroup !== native.backend.processGroup
      ? `processGroup differs: native_status=${String(native.backend.processGroup)} debug-runtime=${String(serverNativeBackend.processGroup)}`
      : null,
  ].filter((mismatch): mismatch is string => Boolean(mismatch))

  return {
    status: mismatches.length > 0 ? 'drift' : 'matched',
    backendOwner: native.backend.owner,
    serverNativeBackend,
    mismatches,
  }
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

    const nativeLifecycle = compareNativeLifecycleDiagnostics(server, native)
    const snapshot = { frontend, server, native, nativeLifecycle }
    console.log('[debugRuntime] snapshot', snapshot)
    return snapshot
  }

  return debugWindow
}
