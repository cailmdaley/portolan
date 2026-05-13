export interface NativePortolanStatus {
  app: {
    productName: string
    version: string
    profile: string
    frontendDist: string
    projectRoot: string
  }
  backend: {
    url: string
    reachable: boolean
    owner: 'app' | 'external' | 'failed'
    launchKind: string
    processGroup: boolean
    pid: number | null
    startedAtUnix: number | null
    lastError: string | null
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
