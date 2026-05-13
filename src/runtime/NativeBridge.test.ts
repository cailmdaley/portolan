import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isNativePortolanRuntime, openNativeWorkspaceWindow } from './NativeBridge'

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
