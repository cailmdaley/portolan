import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpApi } from '../HttpApi.js';
import { CityManager } from '../CityManager.js';
import { OriginManager } from '../OriginManager.js';
import { RemoteAgentCoordinator } from '../RemoteAgentCoordinator.js';
import { RecentFileTracker } from '../RecentFileTracker.js';
import { httpRequest, stubOriginLookup, stubPersistenceLookup } from './test-utils.js';

function createCoordinatorFixture() {
  const cityManager = new CityManager();
  const originManager = new OriginManager();
  const recentFileTracker = new RecentFileTracker();
  const previousSessions = new Map();
  const callbacks = {
    assignSessionToCity: vi.fn(),
    broadcastActivity: vi.fn(),
    broadcastState: vi.fn(),
    rebuildCities: vi.fn(),
    recoverRemoteAgent: vi.fn().mockResolvedValue({
      sshHost: 'candide',
      tunnel: 'reachable',
      agent: 'restarted',
      message: 'candide: tunnel reachable; restarted portolan-agent-rust-preview',
    }),
  };

  const coordinator = new RemoteAgentCoordinator(
    cityManager,
    originManager,
    recentFileTracker,
    previousSessions,
    callbacks,
  );

  return { cityManager, originManager, previousSessions, callbacks, coordinator };
}

const stubCityLookup = {
  getCityById: () => null,
};

describe('HttpApi — /debug-runtime endpoint', () => {
  let api: HttpApi;

  beforeEach(() => {
    api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  it('returns process diagnostics when no runtime provider is set', async () => {
    const res = await httpRequest(api, 'GET', '/debug-runtime');

    expect(res.status).toBe(200);
    expect(typeof res.data.timestamp).toBe('number');
    expect(typeof res.data.pid).toBe('number');
    expect(typeof res.data.uptimeSeconds).toBe('number');
    expect(typeof res.data.memory?.rss).toBe('number');
    expect(res.data.runtime).toEqual({});
  });

  it('includes diagnostics from configured runtime provider', async () => {
    api.setRuntimeDiagnosticsProvider(() => ({
      sessions: { local: 1, remote: 2, total: 3 },
      maps: { remoteActivities: 4 },
    }));

    const res = await httpRequest(api, 'GET', '/debug-runtime');

    expect(res.status).toBe(200);
    expect(res.data.runtime).toEqual({
      sessions: { local: 1, remote: 2, total: 3 },
      maps: { remoteActivities: 4 },
    });
  });

  it('returns 500 when diagnostics provider throws', async () => {
    api.setRuntimeDiagnosticsProvider(() => {
      throw new Error('boom');
    });

    const res = await httpRequest(api, 'GET', '/debug-runtime');

    expect(res.status).toBe(500);
    expect(res.data.error).toBe('Failed to collect runtime diagnostics');
  });

  it('clears remote shuttle snapshot diagnostics after a remote disconnect', async () => {
    const { originManager, coordinator } = createCoordinatorFixture();

    api.setRuntimeDiagnosticsProvider(() => ({
      shuttle: {
        remoteSnapshots: coordinator.getRemoteShuttleSnapshotStats(),
      },
    }));

    coordinator.handleShuttleSnapshot('remote-candide', {
      eligible: [{ fiberId: 'remote-fiber', state: 'idle' }],
      blocked: [],
      orphans: ['orphaned-fiber'],
    });

    const ws = { close: vi.fn() } as any;
    originManager.registerAgent('candide', ws, 'candide', undefined, 'rust');
    const origin = originManager.handleDisconnect(ws);
    expect(origin?.id).toBe('remote-candide');

    const connectedRes = await httpRequest(api, 'GET', '/debug-runtime');
    expect(connectedRes.status).toBe(200);
    expect(connectedRes.data.runtime.shuttle.remoteSnapshots).toEqual([
      expect.objectContaining({
        originId: 'remote-candide',
        eligibleCount: 1,
        blockedCount: 0,
        orphanCount: 1,
      }),
    ]);

    coordinator.handleAgentDisconnect(origin!.id, origin!.sshHost, origin!.agentRuntime);

    const disconnectedRes = await httpRequest(api, 'GET', '/debug-runtime');
    expect(disconnectedRes.status).toBe(200);
    expect(disconnectedRes.data.runtime.shuttle.remoteSnapshots).toEqual([]);
  });
});
