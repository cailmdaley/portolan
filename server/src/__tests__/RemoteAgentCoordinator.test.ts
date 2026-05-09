import { describe, expect, it, vi } from 'vitest';
import { CityManager } from '../CityManager.js';
import { OriginManager } from '../OriginManager.js';
import { RecentFileTracker } from '../RecentFileTracker.js';
import { RemoteAgentCoordinator } from '../RemoteAgentCoordinator.js';

describe('RemoteAgentCoordinator', () => {
  function createCoordinator(
    overrides: Partial<ConstructorParameters<typeof RemoteAgentCoordinator>[4]> = {},
  ) {
    const cityManager = new CityManager();
    const originManager = new OriginManager();
    const recentFileTracker = new RecentFileTracker();
    const previousSessions = new Map();
    const callbacks = {
      assignSessionToCity(session: any, city: any) {
        session.cityId = city.id;
        session.workerHex = { q: 1, r: 0 };
      },
      broadcastActivity: vi.fn(),
      broadcastState: vi.fn(),
      rebuildCities: vi.fn(function (this: void) {
        cityManager.updateFromSessions([
          { cwd: '/remote/pure_eb', originId: 'remote-candide' },
        ]);
      }),
      recoverRemoteAgent: vi.fn().mockResolvedValue({
        sshHost: 'candide',
        tunnel: 'reachable',
        agent: 'restarted',
        message: 'candide: tunnel reachable; restarted portolan-agent',
      }),
      ...overrides,
    };

    const coordinator = new RemoteAgentCoordinator(
      cityManager,
      originManager,
      recentFileTracker,
      previousSessions,
      callbacks,
    );

    return { cityManager, originManager, recentFileTracker, previousSessions, callbacks, coordinator };
  }

  it('records remote Read activity into RecentFileTracker', () => {
    const { cityManager, originManager, recentFileTracker, coordinator } = createCoordinator();

    originManager.registerAgent('candide', { close: vi.fn() } as any, 'candide');
    cityManager.setOriginPosition('remote-candide', { q: 6, r: 0 });
    cityManager.setOriginSshHost('remote-candide', 'candide');

    coordinator.handleAgentSessionsUpdate('remote-candide', [
      {
        name: 'paper',
        tmuxSession: 'paper',
        cwd: '/remote/pure_eb',
      },
    ]);

    coordinator.handleAgentActivity('remote-candide', {
      tmuxSession: 'paper',
      tool: 'Read',
      fullPath: '/remote/pure_eb/slides.qmd',
      timestamp: 1234,
    });

    expect(recentFileTracker.getRecentFiles('remote-remote-candide-paper')).toEqual([
      expect.objectContaining({
        toolName: 'Read',
        fullPath: '/remote/pure_eb/slides.qmd',
      }),
    ]);
  });

  it('starts remote agent recovery when the agent WebSocket disconnects', async () => {
    const { originManager, callbacks, coordinator } = createCoordinator();
    const ws = { close: vi.fn() } as any;

    const origin = originManager.registerAgent('candide', ws, 'candide');
    const disconnectedOrigin = originManager.handleDisconnect(ws);

    expect(disconnectedOrigin?.id).toBe(origin.id);

    coordinator.handleAgentDisconnect(disconnectedOrigin!.id, disconnectedOrigin!.sshHost);

    await vi.waitFor(() => {
      expect(callbacks.recoverRemoteAgent).toHaveBeenCalledWith('candide');
    });
    await vi.waitFor(() => {
      expect(coordinator.getRemoteAgentRecoveryStats()[0]).toEqual(expect.objectContaining({
        originId: 'remote-candide',
        sshHost: 'candide',
        inFlight: false,
        lastResult: expect.objectContaining({
          tunnel: 'reachable',
          agent: 'restarted',
        }),
      }));
    });
  });

  it('clears remote agent recovery state after a fresh sessions update', async () => {
    const { originManager, callbacks, coordinator } = createCoordinator();
    const ws = { close: vi.fn() } as any;

    originManager.registerAgent('candide', ws, 'candide');
    const disconnectedOrigin = originManager.handleDisconnect(ws)!;
    coordinator.handleAgentDisconnect(disconnectedOrigin.id, disconnectedOrigin.sshHost);

    await vi.waitFor(() => {
      expect(callbacks.recoverRemoteAgent).toHaveBeenCalledWith('candide');
    });

    coordinator.handleAgentSessionsUpdate('remote-candide', [
      {
        name: 'review',
        tmuxSession: 'review',
        cwd: '/remote/pure_eb',
      },
    ]);

    expect(coordinator.getRemoteAgentRecoveryStats()).toEqual([]);
  });
});
