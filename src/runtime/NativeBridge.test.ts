import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
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
      title: 'Portolan - note.md',
    })).resolves.toBe('workspace-1')

    expect(invoke).toHaveBeenCalledWith('open_workspace_window', {
      routeUrl: '#city=portolan&mode=narrative&file=%2Ftmp%2Fnote.md',
      title: 'Portolan - note.md',
    })
  })
})

describe('native workspace window state commands', () => {
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
      title: 'Portolan - Find',
    })).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith('record_workspace_window_route', {
      routeUrl: '#city=portolan&mode=find',
      title: 'Portolan - Find',
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
