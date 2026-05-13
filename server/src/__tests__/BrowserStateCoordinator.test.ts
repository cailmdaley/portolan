import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { BrowserStateCoordinator } from '../BrowserStateCoordinator.js';

describe('BrowserStateCoordinator', () => {
  function makeCoordinator({
    cities = [],
    sessions = [],
    recentActivities = [],
    countOpenFibers = vi.fn().mockResolvedValue(0),
    getMeetingState,
  }: {
    cities?: any[];
    sessions?: any[];
    recentActivities?: any[];
    countOpenFibers?: (cityPath: string) => Promise<number>;
    getMeetingState?: () => any;
  } = {}) {
    return new BrowserStateCoordinator({
      cityManager: {
        getCities: () => cities,
        updateClaimsStatus: () => {},
        updatePlaygroundsStatus: () => {},
      } as any,
      cityPersistence: {} as any,
      eventWatcher: {
        getRecentActivities: () => recentActivities,
      } as any,
      gitStatusManager: {
        getStatus: () => undefined,
      } as any,
      originManager: {
        getOrigins: () => [],
      } as any,
      previousSessions: new Map(),
      recentFileTracker: {} as any,
      sessionLookup: {
        getAllSessions: () => sessions,
      },
      getMeetingState,
      countOpenFibers,
    });
  }

  it('caches local fiber counts between state snapshots', async () => {
    const countOpenFibers = vi.fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(7);
    const city = {
      id: 'city-1',
      name: 'portolan',
      path: '/project/portolan',
      position: { q: 0, r: 0 },
      originId: 'local',
    };
    const coordinator = makeCoordinator({ cities: [city], countOpenFibers });

    await expect(coordinator.buildState()).resolves.toMatchObject({
      cities: [expect.objectContaining({ id: 'city-1', fiberCount: 3 })],
    });
    await expect(coordinator.buildState()).resolves.toMatchObject({
      cities: [expect.objectContaining({ id: 'city-1', fiberCount: 3 })],
    });
    expect(countOpenFibers).toHaveBeenCalledTimes(1);

    await coordinator['refreshFiberCounts']();
    await expect(coordinator.buildState()).resolves.toMatchObject({
      cities: [expect.objectContaining({ id: 'city-1', fiberCount: 7 })],
    });
    expect(countOpenFibers).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent local fiber count reads', async () => {
    let resolveCount!: (count: number) => void;
    const countOpenFibers = vi.fn(() => new Promise<number>((resolve) => {
      resolveCount = resolve;
    }));
    const city = {
      id: 'city-1',
      name: 'portolan',
      path: '/project/portolan',
      position: { q: 0, r: 0 },
      originId: 'local',
    };
    const coordinator = makeCoordinator({ cities: [city], countOpenFibers });

    const first = coordinator.buildState();
    const second = coordinator.buildState();
    resolveCount(5);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        cities: [expect.objectContaining({ fiberCount: 5 })],
      }),
      expect.objectContaining({
        cities: [expect.objectContaining({ fiberCount: 5 })],
      }),
    ]);
    expect(countOpenFibers).toHaveBeenCalledTimes(1);
    expect(coordinator.getFiberCountCacheStats()).toMatchObject({
      entries: 1,
      inFlight: 0,
      localCities: 1,
    });
  });

  it('includes meeting bridge state in websocket snapshots', async () => {
    const coordinator = makeCoordinator({
      getMeetingState: () => ({
        activeMeeting: {
          recentTranscriptChunks: [
            {
              chunkIndex: 2,
              receivedAt: 200,
              text: 'Pull up the prior calibration plot.',
            },
          ],
          meetingId: 'meeting-1',
          status: 'running',
          startedAt: 123,
          sessionId: 'worker-1',
          tmuxSession: 'worker-1',
          originId: 'local',
          cityPath: '/project/portolan',
          transcriptPath: '/tmp/transcript.jsonl',
          transcriptMarkdownPath: '/tmp/transcript.md',
          metadataPath: '/tmp/meeting.json',
          chunkCount: 2,
        },
        lastMeeting: null,
      }),
    });

    await expect(coordinator.buildState()).resolves.toMatchObject({
      meetingBridge: {
        activeMeeting: {
          meetingId: 'meeting-1',
          status: 'running',
          recentTranscriptChunks: [
            expect.objectContaining({
              chunkIndex: 2,
              text: 'Pull up the prior calibration plot.',
            }),
          ],
        },
        lastMeeting: null,
      },
    });
  });

  it('includes activity buffers in initial snapshots but omits them from routine broadcasts', async () => {
    const coordinator = makeCoordinator({
      sessions: [{
        id: 'session-1',
        name: 'worker',
        tmuxSession: 'worker-1',
        originId: 'local',
        cwd: '/project/portolan',
        status: 'idle',
        createdAt: 1,
        lastActivity: 2,
      }],
      recentActivities: [{
        tmuxSession: 'worker-1',
        tool: 'Read',
        fullPath: '/project/portolan/src/main.ts',
        timestamp: 3,
      }],
    });
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;

    await coordinator.attachClient(ws);
    const initial = JSON.parse(ws.send.mock.calls[0][0]);
    expect(initial.activities).toMatchObject({
      'local:worker-1': [expect.objectContaining({ tool: 'Read' })],
    });

    await coordinator.broadcastCurrentState();
    const broadcast = JSON.parse(ws.send.mock.calls[1][0]);
    expect(broadcast.activities).toBeUndefined();
    expect(coordinator.getBroadcastStats()).toMatchObject({
      stateBuilds: {
        withActivities: 1,
        withoutActivities: 1,
      },
    });
  });

  it('reports browser-state websocket payload fanout diagnostics', async () => {
    const coordinator = makeCoordinator();
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;

    await coordinator.attachClient(ws);
    expect(coordinator.getBroadcastStats()).toMatchObject({
      clients: 1,
      state: {
        initialSnapshots: 1,
        broadcasts: 0,
        duplicateBroadcastsSuppressed: 0,
        messagesSent: 1,
        lastRecipientCount: 1,
      },
    });

    coordinator.broadcast({ cities: [], sessions: [] });

    const stats = coordinator.getBroadcastStats();
    expect(stats.state).toMatchObject({
      initialSnapshots: 1,
      broadcasts: 1,
      duplicateBroadcastsSuppressed: 0,
      messagesSent: 2,
      lastRecipientCount: 1,
    });
    expect(stats.state.lastPayloadBytes).toBeGreaterThan(0);
    expect(stats.state.approxBytesSent).toBeGreaterThanOrEqual(stats.state.lastPayloadBytes);
    expect(stats.state.lastSentAt).toEqual(expect.any(Number));
    expect(stats.stateBuilds.timings.withActivities).toMatchObject({
      count: 1,
      lastCompletedAt: expect.any(Number),
    });
    expect(stats.statePipeline.canonicalize).toMatchObject({
      count: 1,
      lastCompletedAt: expect.any(Number),
    });
    expect(stats.statePipeline.payloadPrepare).toMatchObject({
      count: 1,
      lastCompletedAt: expect.any(Number),
    });
    expect(stats.statePipeline.payloadStringify).toMatchObject({
      count: 1,
      lastCompletedAt: expect.any(Number),
    });
  });

  it('suppresses duplicate full-state broadcasts after the first send', async () => {
    const coordinator = makeCoordinator();
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;
    const state = { cities: [], sessions: [] };

    await coordinator.attachClient(ws);
    coordinator.broadcast(state);
    coordinator.broadcast({ cities: [], sessions: [] });

    expect(ws.send).toHaveBeenCalledTimes(2);
    const stats = coordinator.getBroadcastStats();
    expect(stats.state).toMatchObject({
      initialSnapshots: 1,
      broadcasts: 1,
      duplicateBroadcastsSuppressed: 1,
      messagesSent: 2,
      lastRecipientCount: 1,
    });
    expect(stats.state.lastSuppressedAt).toEqual(expect.any(Number));
  });

  it('sends routine state deltas after the first full-state broadcast', async () => {
    const coordinator = makeCoordinator();
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;
    const city = {
      id: 'city-1',
      name: 'portolan',
      path: '/project/portolan',
      position: { q: 0, r: 0 },
      originId: 'local',
      fiberCount: 3,
    };
    const session = {
      id: 'session-1',
      name: 'worker',
      tmuxSession: 'worker-1',
      originId: 'local',
      cwd: '/project/portolan',
      status: 'idle',
      createdAt: 1,
      lastActivity: 2,
    };

    await coordinator.attachClient(ws);
    coordinator.broadcast({ cities: [city], sessions: [session] });
    coordinator.broadcast({
      cities: [{ ...city, fiberCount: 4 }],
      sessions: [],
    });

    const full = JSON.parse(ws.send.mock.calls[1][0]);
    const delta = JSON.parse(ws.send.mock.calls[2][0]);
    expect(full).toMatchObject({
      cities: [expect.objectContaining({ id: 'city-1', fiberCount: 3 })],
      sessions: [expect.objectContaining({ id: 'session-1' })],
    });
    expect(delta).toEqual({
      type: 'stateDelta',
      cities: {
        upsert: [expect.objectContaining({ id: 'city-1', fiberCount: 4 })],
        remove: [],
      },
      sessions: {
        upsert: [],
        remove: ['session-1'],
      },
    });
    expect(coordinator.getBroadcastStats().state).toMatchObject({
      broadcasts: 2,
      fullBroadcasts: 2,
      deltaBroadcasts: 1,
      lastPayloadKind: 'state-delta',
    });
  });

  it('skips hidden browser clients during routine full-state broadcasts', async () => {
    const coordinator = makeCoordinator();
    const activeWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;
    const hiddenWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;

    await coordinator.attachClient(activeWs);
    await coordinator.attachClient(hiddenWs);
    coordinator.handleBrowserAttention(hiddenWs, 'hidden');

    coordinator.broadcast({ cities: [], sessions: [] });

    expect(activeWs.send).toHaveBeenCalledTimes(2);
    expect(hiddenWs.send).toHaveBeenCalledTimes(1);
    expect(coordinator.getBroadcastStats()).toMatchObject({
      clients: 2,
      clientAttention: {
        active: 1,
        'visible-unfocused': 0,
        hidden: 1,
      },
      state: {
        broadcasts: 1,
        messagesSent: 3,
        lastRecipientCount: 1,
        hiddenRecipientsSkipped: 1,
        lastHiddenRecipientsSkipped: 1,
      },
    });
  });

  it('refreshes a hidden browser client when it becomes visible again', async () => {
    const coordinator = makeCoordinator();
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;

    await coordinator.attachClient(ws);
    coordinator.handleBrowserAttention(ws, 'hidden');
    coordinator.broadcast({ cities: [], sessions: [] });
    expect(ws.send).toHaveBeenCalledTimes(1);

    coordinator.handleBrowserAttention(ws, 'visible-unfocused');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(coordinator.getBroadcastStats()).toMatchObject({
      clientAttention: {
        active: 0,
        'visible-unfocused': 1,
        hidden: 0,
      },
      state: {
        clientRefreshes: 1,
        messagesSent: 2,
      },
    });
  });

  it('reports activity websocket payload fanout diagnostics', async () => {
    const coordinator = makeCoordinator();
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;

    await coordinator.attachClient(ws);
    coordinator.broadcastActivity({
      tmuxSession: 'worker-1',
      toolName: 'Read',
      filePath: '/tmp/file.ts',
      timestamp: Date.now(),
    } as any, 'local');

    const stats = coordinator.getBroadcastStats();
    expect(stats.activity).toMatchObject({
      broadcasts: 1,
      messagesSent: 1,
      lastRecipientCount: 1,
    });
    expect(stats.activity.lastPayloadBytes).toBeGreaterThan(0);
    expect(stats.activity.approxBytesSent).toBeGreaterThan(0);
  });

  it('skips hidden browser clients during activity broadcasts', async () => {
    const coordinator = makeCoordinator();
    const activeWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;
    const hiddenWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;

    await coordinator.attachClient(activeWs);
    await coordinator.attachClient(hiddenWs);
    coordinator.handleBrowserAttention(hiddenWs, 'hidden');
    coordinator.broadcastActivity({
      tmuxSession: 'worker-1',
      toolName: 'Read',
      filePath: '/tmp/file.ts',
      timestamp: Date.now(),
    } as any, 'local');

    expect(activeWs.send).toHaveBeenCalledTimes(2);
    expect(hiddenWs.send).toHaveBeenCalledTimes(1);
    expect(coordinator.getBroadcastStats()).toMatchObject({
      activity: {
        broadcasts: 1,
        messagesSent: 1,
        lastRecipientCount: 1,
        hiddenRecipientsSkipped: 1,
        lastHiddenRecipientsSkipped: 1,
      },
    });
  });
});
