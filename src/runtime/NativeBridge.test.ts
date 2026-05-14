import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  duplicateNativeWorkspaceWindow,
  getNativePortolanStatus,
  getRecentNativeWorkspaceWindows,
  isNativePortolanRuntime,
  openNativeWorkspaceWindow,
  recordNativeWorkspaceWindowRoute,
  refreshNativeWorkspaceWindow,
  restoreRecentNativeWorkspaceWindows,
} from './NativeBridge'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}))

beforeEach(() => {
  invoke.mockReset()
  delete (window as any).__TAURI_INTERNALS__
})

describe('isNativePortolanRuntime', () => {
  it('is false for the ordinary browser runtime', () => {
    expect(isNativePortolanRuntime({})).toBe(false)
  })

  it('is true when Tauri injects its internals marker', () => {
    expect(isNativePortolanRuntime({ __TAURI_INTERNALS__: {} })).toBe(true)
  })
})

describe('getNativePortolanStatus', () => {
  it('returns native bridge status only in the native runtime', async () => {
    await expect(getNativePortolanStatus()).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    ;(window as any).__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce({
      app: {
        productName: 'Portolan',
        version: '0.0.0',
        profile: 'debug',
        frontendDist: '../dist',
        projectRoot: '/app',
        resourceDir: '/app/Resources',
      },
      backend: {
        url: 'http://localhost:4004',
        reachable: true,
        owner: 'app',
        launchKind: 'node-dist-resource',
        processGroup: false,
        cwd: '/app/server',
        entry: null,
        resourceDir: '/app/Resources',
        pid: 123,
        startedAtUnix: 1700000000,
        lastError: null,
      },
      workspaceWindows: {
        recentCount: 0,
        mainRouteUrl: null,
        workspaceCount: 0,
        routes: [],
      },
    })

    await expect(getNativePortolanStatus()).resolves.toMatchObject({
      app: { productName: 'Portolan' },
      backend: { launchKind: 'node-dist-resource', owner: 'app' },
      workspaceWindows: { recentCount: 0 },
    })
    expect(invoke).toHaveBeenCalledWith('native_status')
  })
})

describe('openNativeWorkspaceWindow', () => {
  it('returns null outside the native runtime', async () => {
    delete (window as any).__TAURI_INTERNALS__

    await expect(openNativeWorkspaceWindow({
      routeUrl: '#city=portolan&mode=narrative',
    })).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('invokes the native window command in Tauri', async () => {
    ;(window as any).__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce('workspace-1')

    await expect(openNativeWorkspaceWindow({
      routeUrl: '#city=portolan&mode=narrative&file=%2Ftmp%2Fnote.md',
      title: 'note.md · portolan · Portolan',
    })).resolves.toBe('workspace-1')

    expect(invoke).toHaveBeenCalledWith('open_workspace_window', {
      routeUrl: '#city=portolan&mode=narrative&file=%2Ftmp%2Fnote.md',
      title: 'note.md · portolan · Portolan',
    })
  })
})

describe('native workspace window state commands', () => {
  it('skips workspace duplication outside the native runtime', async () => {
    await expect(duplicateNativeWorkspaceWindow()).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('duplicates the current native window in Tauri', async () => {
    ;(window as any).__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce('workspace-2')

    await expect(duplicateNativeWorkspaceWindow()).resolves.toBe('workspace-2')
    expect(invoke).toHaveBeenCalledWith('duplicate_workspace_window')
  })

  it('skips route persistence outside the native runtime', async () => {
    await expect(recordNativeWorkspaceWindowRoute({
      routeUrl: '#city=portolan',
      title: 'Portolan',
    })).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('records the current route in Tauri', async () => {
    ;(window as any).__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce(undefined)

    await expect(recordNativeWorkspaceWindowRoute({
      routeUrl: '#city=portolan&mode=find',
      title: 'Find · portolan · Portolan',
    })).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith('record_workspace_window_route', {
      routeUrl: '#city=portolan&mode=find',
      title: 'Find · portolan · Portolan',
    })
  })

  it('refreshes the current native window in Tauri', async () => {
    ;(window as any).__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce(undefined)

    await expect(refreshNativeWorkspaceWindow()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('refresh_workspace_window')
  })

  it('returns recent native windows only in Tauri', async () => {
    await expect(getRecentNativeWorkspaceWindows()).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    ;(window as any).__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce([{ label: 'main', routeUrl: '#city=portolan', title: 'Portolan', updatedAtUnix: 1 }])

    await expect(getRecentNativeWorkspaceWindows()).resolves.toEqual([
      { label: 'main', routeUrl: '#city=portolan', title: 'Portolan', updatedAtUnix: 1 },
    ])
    expect(invoke).toHaveBeenCalledWith('recent_workspace_windows')
  })

  it('restores recent native windows only in Tauri', async () => {
    await expect(restoreRecentNativeWorkspaceWindows()).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    ;(window as any).__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce(['workspace-restore-1'])

    await expect(restoreRecentNativeWorkspaceWindows()).resolves.toEqual(['workspace-restore-1'])
    expect(invoke).toHaveBeenCalledWith('restore_recent_workspace_windows')
  })
})
