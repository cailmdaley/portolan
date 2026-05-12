import { describe, expect, it, vi } from 'vitest';
import { BrowserStateCoordinator } from '../BrowserStateCoordinator.js';

describe('BrowserStateCoordinator', () => {
  function makeCoordinator({
    cities = [],
    countOpenFibers = vi.fn().mockResolvedValue(0),
    getMeetingState,
  }: {
    cities?: any[];
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
        getRecentActivities: () => [],
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
        getAllSessions: () => [],
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
});
