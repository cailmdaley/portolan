import { describe, expect, it } from 'vitest'

import {
  compareNativeLifecycleDiagnostics,
} from './FrontendRuntimeDiagnostics'
import type { NativePortolanStatus } from './NativeBridge'

function nativeStatus(overrides: Partial<NativePortolanStatus['backend']> = {}): NativePortolanStatus {
  return {
    app: {
      productName: 'Portolan',
      version: '0.1.0',
      profile: 'release',
      frontendDist: '/app/dist',
      projectRoot: '/repo',
      resourceDir: '/app/Contents/Resources',
    },
    backend: {
      url: 'http://127.0.0.1:4004',
      reachable: true,
      owner: 'app',
      launchKind: 'node-dist-resource',
      processGroup: true,
      cwd: '/app/Contents/Resources/server',
      entry: '/app/Contents/Resources/server/dist/index.js',
      resourceDir: '/app/Contents/Resources',
      pid: 123,
      startedAtUnix: 456,
      lastError: null,
      ...overrides,
    },
    workspaceWindows: {
      recentCount: 0,
      mainRouteUrl: null,
      workspaceCount: 1,
      routes: [],
    },
  }
}

describe('compareNativeLifecycleDiagnostics', () => {
  it('treats ordinary browser diagnostics as non-native', () => {
    expect(compareNativeLifecycleDiagnostics({ runtime: {} }, null)).toEqual({
      status: 'browser',
      backendOwner: null,
      serverNativeBackend: null,
      mismatches: [],
    })
  })

  it('reports drift when the frontend is not native but the backend says it is', () => {
    const result = compareNativeLifecycleDiagnostics({
      runtime: {
        nativeBackend: {
          enabled: true,
          launchKind: 'node-dist-resource',
        },
      },
    }, null)

    expect(result.status).toBe('unavailable')
    expect(result.mismatches).toEqual([
      'server reports a native-owned backend, but the frontend is not running in Tauri',
    ])
  })

  it('matches an external backend when the server has no nativeBackend block', () => {
    expect(compareNativeLifecycleDiagnostics(
      { runtime: {} },
      nativeStatus({ owner: 'external', launchKind: 'external-dev-server', processGroup: false }),
    )).toMatchObject({
      status: 'matched',
      backendOwner: 'external',
      serverNativeBackend: null,
      mismatches: [],
    })
  })

  it('matches app-owned backend launch context across native_status and debug-runtime', () => {
    expect(compareNativeLifecycleDiagnostics(
      {
        runtime: {
          nativeBackend: {
            enabled: true,
            backendRoot: '/app/Contents/Resources/server',
            resourceDir: '/app/Contents/Resources',
            launchKind: 'node-dist-resource',
            processGroup: true,
          },
        },
      },
      nativeStatus(),
    )).toMatchObject({
      status: 'matched',
      backendOwner: 'app',
      mismatches: [],
    })
  })

  it('reports missing nativeBackend diagnostics for app-owned native backends', () => {
    const result = compareNativeLifecycleDiagnostics({ runtime: {} }, nativeStatus())

    expect(result.status).toBe('missing-server-native-backend')
    expect(result.mismatches).toEqual([
      'native_status reports a app backend, but /debug-runtime has no nativeBackend block',
    ])
  })

  it('reports field-level native backend drift', () => {
    const result = compareNativeLifecycleDiagnostics(
      {
        runtime: {
          nativeBackend: {
            enabled: true,
            backendRoot: '/different/server',
            resourceDir: '/different/Resources',
            launchKind: 'source-dev',
            processGroup: false,
          },
        },
      },
      nativeStatus(),
    )

    expect(result.status).toBe('drift')
    expect(result.mismatches).toEqual([
      'launchKind differs: native_status=node-dist-resource debug-runtime=source-dev',
      'backendRoot differs: native_status.cwd=/app/Contents/Resources/server debug-runtime=/different/server',
      'resourceDir differs: native_status=/app/Contents/Resources debug-runtime=/different/Resources',
      'processGroup differs: native_status=true debug-runtime=false',
    ])
  })
})
