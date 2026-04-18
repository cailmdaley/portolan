import { describe, expect, it, vi } from 'vitest';
import { HttpApi } from '../HttpApi.js';
import { httpRequest, stubPersistenceLookup } from './test-utils.js';

const stubCityLookup = {
  getCityById: () => null,
};

describe('HttpApi — meeting bridge endpoints', () => {
  const localSession = {
    id: 'worker-1',
    name: 'worker-1',
    tmuxSession: 'worker-1',
    cwd: '/project',
    status: 'working' as const,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    originId: 'local',
  };

  it('returns the current meeting bridge state', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: null, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'GET', '/meeting-bridge');
    expect(res.status).toBe(200);
    expect(meetingBridge.getState).toHaveBeenCalledTimes(1);
    expect(res.data.meeting).toEqual({ activeMeeting: null, lastMeeting: null });
  });

  it('resolves the worker session and starts a local meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: null, lastMeeting: null })),
      start: vi.fn(() => ({ meetingId: 'meeting-1', status: 'running' })),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setSessionLookup({
      findSession: (sessionId: string) => sessionId === localSession.id ? localSession : undefined,
      getAllSessions: () => [localSession],
    });
    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {
      workerId: localSession.id,
      voiceInk: { pollSeconds: 2 },
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.start).toHaveBeenCalledWith({
      target: {
        sessionId: localSession.id,
        tmuxSession: localSession.tmuxSession,
        originId: localSession.originId,
        cwd: localSession.cwd,
        sshHost: undefined,
      },
      initialPrompt: undefined,
      voiceInk: { pollSeconds: 2 },
      parakeet: undefined,
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', status: 'running' });
  });

  it('starts a manual-ingress meeting bridge without VoiceInk options', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: null, lastMeeting: null })),
      start: vi.fn(() => ({ meetingId: 'meeting-manual', status: 'running', sourceType: 'manual' })),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setSessionLookup({
      findSession: (sessionId: string) => sessionId === localSession.id ? localSession : undefined,
      getAllSessions: () => [localSession],
    });
    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {
      workerId: localSession.id,
      sourceType: 'manual',
      initialPrompt: 'Stay ready for HTTP transcript chunks.',
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.start).toHaveBeenCalledWith({
      target: {
        sessionId: localSession.id,
        tmuxSession: localSession.tmuxSession,
        originId: localSession.originId,
        cwd: localSession.cwd,
        sshHost: undefined,
      },
      initialPrompt: 'Stay ready for HTTP transcript chunks.',
      sourceType: 'manual',
      voiceInk: undefined,
      parakeet: undefined,
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-manual', status: 'running', sourceType: 'manual' });
  });

  it('starts a parakeet meeting bridge with custom daemon options', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: null, lastMeeting: null })),
      start: vi.fn(() => ({ meetingId: 'meeting-parakeet', status: 'running', sourceType: 'parakeet' })),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setSessionLookup({
      findSession: (sessionId: string) => sessionId === localSession.id ? localSession : undefined,
      getAllSessions: () => [localSession],
    });
    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {
      workerId: localSession.id,
      sourceType: 'parakeet',
      parakeet: { mode: 'mic', model: 'mlx-community/parakeet-tdt-0.6b-v2', chunkMs: 400 },
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.start).toHaveBeenCalledWith({
      target: {
        sessionId: localSession.id,
        tmuxSession: localSession.tmuxSession,
        originId: localSession.originId,
        cwd: localSession.cwd,
        sshHost: undefined,
      },
      initialPrompt: undefined,
      sourceType: 'parakeet',
      voiceInk: undefined,
      parakeet: { mode: 'mic', model: 'mlx-community/parakeet-tdt-0.6b-v2', chunkMs: 400 },
    });
    expect(res.data.meeting.sourceType).toBe('parakeet');
  });

  it('rejects invalid meeting source types', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setSessionLookup({
      findSession: (sessionId: string) => sessionId === localSession.id ? localSession : undefined,
      getAllSessions: () => [localSession],
    });
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: null, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {
      workerId: localSession.id,
      sourceType: 'bad-source',
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Invalid meeting sourceType');
  });

  it('returns 404 when starting a remote meeting bridge without a resolved ssh host', async () => {
    const remoteSession = {
      ...localSession,
      id: 'remote-worker',
      tmuxSession: 'remote-worker',
      originId: 'remote-candide',
    };

    const api = new HttpApi(
      stubCityLookup as any,
      { getOrigin: () => ({ id: 'remote-candide', type: 'remote' }) } as any,
      stubPersistenceLookup as any,
    );
    api.setSessionLookup({
      findSession: (sessionId: string) => sessionId === remoteSession.id ? remoteSession : undefined,
      getAllSessions: () => [remoteSession],
    });
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: null, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {
      workerId: remoteSession.id,
    });

    expect(res.status).toBe(404);
    expect(res.data.error).toBe('Remote origin not found');
  });

  it('stops the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: null, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(() => ({ meetingId: 'meeting-1', status: 'stopped' })),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/stop');
    expect(res.status).toBe(200);
    expect(meetingBridge.stop).toHaveBeenCalledTimes(1);
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', status: 'stopped' });
  });

  it('routes uploaded transcript chunks into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestChunk: vi.fn(() => ({ meetingId: 'meeting-1', chunkCount: 3, status: 'running' })),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/chunk', {
      chunk: {
        id: 'chunk-3',
        text: 'This should stay tentative.',
      },
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.ingestChunk).toHaveBeenCalledWith({
      id: 'chunk-3',
      text: 'This should stay tentative.',
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', chunkCount: 3, status: 'running' });
  });

  it('routes uploaded transcript chunk batches into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestChunks: vi.fn(() => ({ meetingId: 'meeting-1', chunkCount: 2, status: 'running' })),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/chunks', {
      chunks: [
        { id: 'chunk-1', status: 'partial', text: 'Could we pull up' },
        { id: 'chunk-1', status: 'complete', text: 'Could we pull up the plot' },
      ],
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.ingestChunks).toHaveBeenCalledWith([
      { id: 'chunk-1', status: 'partial', text: 'Could we pull up' },
      { id: 'chunk-1', status: 'complete', text: 'Could we pull up the plot' },
    ]);
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', chunkCount: 2, status: 'running' });
  });

  it('routes operator meeting updates into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestOperatorUpdate: vi.fn(() => ({ meetingId: 'meeting-1', operatorUpdateCount: 2, status: 'running' })),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/update', {
      kind: 'correction',
      text: 'No, this belongs under calibration and remains unresolved.',
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.ingestOperatorUpdate).toHaveBeenCalledWith({
      text: 'No, this belongs under calibration and remains unresolved.',
      kind: 'correction',
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', operatorUpdateCount: 2, status: 'running' });
  });

  it('returns 409 when uploading a transcript chunk without an active meeting', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: null, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestChunk: vi.fn(() => {
        throw new Error('No active meeting bridge');
      }),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/chunk', {
      chunk: { id: 'chunk-x', text: 'hello' },
    });

    expect(res.status).toBe(409);
    expect(res.data.error).toBe('Failed to ingest meeting chunk: No active meeting bridge');
  });

  it('returns 400 when uploading an empty operator update', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestOperatorUpdate: vi.fn(() => {
        throw new Error('Meeting update text is empty');
      }),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/update', {
      text: '',
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Failed to ingest meeting update: Meeting update text is empty');
  });

  it('routes candidate meeting events into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(() => ({ meetingId: 'meeting-1', candidateEventCount: 1, status: 'running' })),
      ingestRetrievalRequest: vi.fn(),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/candidate', {
      kind: 'decision',
      text: 'Accepted note: compare the DES calibration plot before formalizing the conclusion.',
      transcriptChunkIndices: [3],
      operatorUpdateIndices: [1],
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.ingestCandidateEvent).toHaveBeenCalledWith({
      kind: 'decision',
      text: 'Accepted note: compare the DES calibration plot before formalizing the conclusion.',
      transcriptChunkIndices: [3],
      operatorUpdateIndices: [1],
      title: undefined,
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', candidateEventCount: 1, status: 'running' });
  });

  it('returns 400 when uploading an empty candidate event', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(() => {
        throw new Error('Meeting candidate event text is empty');
      }),
      ingestRetrievalRequest: vi.fn(),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/candidate', {
      text: '',
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Failed to ingest meeting candidate event: Meeting candidate event text is empty');
  });

  it('returns 400 when uploading a candidate event without cited provenance', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(() => {
        throw new Error('Meeting candidate event requires transcript or operator provenance');
      }),
      ingestRetrievalRequest: vi.fn(),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/candidate', {
      text: 'Accepted note with no provenance.',
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Failed to ingest meeting candidate event: Meeting candidate event requires transcript or operator provenance');
  });

  it('routes retrieval requests into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(() => ({ meetingId: 'meeting-1', retrievalRequestCount: 1, status: 'running' })),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/retrieval', {
      text: 'Find the calibration plot and prior DES weighting decision.',
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.ingestRetrievalRequest).toHaveBeenCalledWith({
      text: 'Find the calibration plot and prior DES weighting decision.',
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', retrievalRequestCount: 1, status: 'running' });
  });

  it('routes retrieved evidence into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
      ingestRetrievedEvidence: vi.fn(() => ({ meetingId: 'meeting-1', retrievalEvidenceCount: 1, status: 'running' })),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/retrieval/evidence', {
      type: 'fiber',
      title: 'use-des-weights',
      fiberId: 'use-des-weights',
      requestIndex: 1,
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.ingestRetrievedEvidence).toHaveBeenCalledWith({
      type: 'fiber',
      title: 'use-des-weights',
      fiberId: 'use-des-weights',
      line: undefined,
      match: undefined,
      path: undefined,
      requestIndex: 1,
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', retrievalEvidenceCount: 1, status: 'running' });
  });

  it('routes candidate promotions into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
      promoteCandidateEvent: vi.fn(async () => ({
        meetingId: 'meeting-1',
        promotedCandidateEventCount: 1,
        status: 'running',
      })),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/candidate/promote', {
      eventIndex: 3,
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.promoteCandidateEvent).toHaveBeenCalledWith(3);
    expect(res.data.meeting).toEqual({
      meetingId: 'meeting-1',
      promotedCandidateEventCount: 1,
      status: 'running',
    });
  });

  it('routes live brief promotions into the active meeting bridge', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null })),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
      promoteLiveBrief: vi.fn(async () => ({
        meetingId: 'meeting-1',
        briefPromotionCount: 1,
        status: 'running',
      })),
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/brief/promote', {
      title: 'Meeting brief: calibration still open',
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.promoteLiveBrief).toHaveBeenCalledWith('Meeting brief: calibration still open');
    expect(res.data.meeting).toEqual({
      meetingId: 'meeting-1',
      briefPromotionCount: 1,
      status: 'running',
    });
  });

  it('returns 400 when promoting an unknown candidate event', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
      promoteCandidateEvent: vi.fn(async () => {
        throw new Error('Meeting candidate event not found: 9');
      }),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/candidate/promote', {
      eventIndex: 9,
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Failed to promote meeting candidate event: Meeting candidate event not found: 9');
  });

  it('returns 400 when uploading an empty retrieval request', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(() => {
        throw new Error('Meeting retrieval request text is empty');
      }),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/retrieval', {
      text: '',
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Failed to ingest meeting retrieval request: Meeting retrieval request text is empty');
  });

  it('returns 400 when uploading invalid retrieved evidence', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      ingestCandidateEvent: vi.fn(),
      ingestRetrievalRequest: vi.fn(),
      ingestRetrievedEvidence: vi.fn(() => {
        throw new Error('Meeting retrieved evidence title is empty');
      }),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/retrieval/evidence', {
      type: 'fiber',
      title: '',
      fiberId: 'use-des-weights',
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Failed to ingest meeting retrieved evidence: Meeting retrieved evidence title is empty');
  });

  it('returns 400 when promoting an empty meeting brief', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: { meetingId: 'meeting-1' }, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
      promoteLiveBrief: vi.fn(async () => {
        throw new Error('Meeting live brief is empty');
      }),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/brief/promote', {});

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Failed to promote meeting brief: Meeting live brief is empty');
  });
});
