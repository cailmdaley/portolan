import { describe, expect, it, vi } from 'vitest';
import { CityManager } from '../CityManager.js';
import { OriginManager } from '../OriginManager.js';
import { RecentFileTracker } from '../RecentFileTracker.js';
import { RemoteAgentCoordinator } from '../RemoteAgentCoordinator.js';

describe('RemoteAgentCoordinator', () => {
  it('records remote Read activity into RecentFileTracker', () => {
    const cityManager = new CityManager();
    const originManager = new OriginManager();
    const recentFileTracker = new RecentFileTracker();
    const previousSessions = new Map();

    originManager.registerAgent('candide', { close: vi.fn() } as any, 'candide');
    cityManager.setOriginPosition('remote-candide', { q: 6, r: 0 });
    cityManager.setOriginSshHost('remote-candide', 'candide');

    const coordinator = new RemoteAgentCoordinator(
      cityManager,
      originManager,
      recentFileTracker,
      previousSessions,
      {
        assignSessionToCity(session, city) {
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
        reconnectTunnel: vi.fn(),
      },
    );

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
});
