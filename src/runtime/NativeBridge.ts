export interface NativePortolanStatus {
  app: {
    productName: string
    version: string
    profile: string
    frontendDist: string
    projectRoot: string
    resourceDir: string | null
  }
  backend: {
    url: string
    reachable: boolean
    owner: 'app' | 'external' | 'failed'
    launchKind: string
    processGroup: boolean
    cwd: string
    entry: string | null
    resourceDir: string | null
    pid: number | null
    startedAtUnix: number | null
    lastError: string | null
  }
  workspaceWindows: {
    recentCount: number
    mainRouteUrl: string | null
    workspaceCount: number
    routes: Array<{
      label: string
      routeUrl: string
      title: string
      isMain: boolean
      updatedAtUnix: number
    }>
  }
}

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown
}

export function isNativePortolanRuntime(target: Partial<TauriWindow> = window as TauriWindow): boolean {
  return Boolean(target.__TAURI_INTERNALS__)
}

export async function getNativePortolanStatus(): Promise<NativePortolanStatus | null> {
  if (!isNativePortolanRuntime()) return null

  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<NativePortolanStatus>('native_status')
}

export interface NativeWorkspaceWindowArgs {
  routeUrl: string
  title?: string
}

export interface NativeWorkspaceWindowRecord {
  label: string
  routeUrl: string
  title: string
  updatedAtUnix: number
}

export async function openNativeWorkspaceWindow(
  args: NativeWorkspaceWindowArgs,
): Promise<string | null> {
  if (!isNativePortolanRuntime()) return null

  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('open_workspace_window', { ...args })
}

export async function recordNativeWorkspaceWindowRoute(
  args: NativeWorkspaceWindowArgs,
): Promise<boolean> {
  if (!isNativePortolanRuntime()) return false

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('record_workspace_window_route', { ...args })
  return true
}

export async function refreshNativeWorkspaceWindow(): Promise<boolean> {
  if (!isNativePortolanRuntime()) return false

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('refresh_workspace_window')
  return true
}

export async function getRecentNativeWorkspaceWindows(): Promise<NativeWorkspaceWindowRecord[] | null> {
  if (!isNativePortolanRuntime()) return null

  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<NativeWorkspaceWindowRecord[]>('recent_workspace_windows')
}

export async function restoreRecentNativeWorkspaceWindows(): Promise<string[] | null> {
  if (!isNativePortolanRuntime()) return null

  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string[]>('restore_recent_workspace_windows')
}
