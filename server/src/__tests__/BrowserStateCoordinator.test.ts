import { describe, expect, it } from 'vitest';
import { BrowserStateCoordinator } from '../BrowserStateCoordinator.js';

describe('BrowserStateCoordinator', () => {
  it('includes meeting bridge state in websocket snapshots', async () => {
    const coordinator = new BrowserStateCoordinator({
      cityManager: {
        getCities: () => [],
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
