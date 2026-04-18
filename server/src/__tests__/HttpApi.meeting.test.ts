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
    };

    api.setSessionLookup({
      findSession: (sessionId: string) => (sessionId === localSession.id ? localSession : undefined),
      getAllSessions: () => [localSession],
    });
    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {
      workerId: localSession.id,
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
      parakeet: undefined,
    });
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', status: 'running' });
  });

  it('forwards a custom initialPrompt and parakeet options', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    const meetingBridge = {
      getState: vi.fn(() => ({ activeMeeting: null, lastMeeting: null })),
      start: vi.fn(() => ({ meetingId: 'meeting-2', status: 'running' })),
      stop: vi.fn(),
    };

    api.setSessionLookup({
      findSession: (sessionId: string) => (sessionId === localSession.id ? localSession : undefined),
      getAllSessions: () => [localSession],
    });
    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {
      workerId: localSession.id,
      initialPrompt: 'Custom bootstrap',
      parakeet: { mode: 'mic', model: 'mlx-community/parakeet-tdt-0.6b-v3' },
    });

    expect(res.status).toBe(200);
    expect(meetingBridge.start).toHaveBeenCalledWith({
      target: expect.objectContaining({ sessionId: localSession.id }),
      initialPrompt: 'Custom bootstrap',
      parakeet: { mode: 'mic', model: 'mlx-community/parakeet-tdt-0.6b-v3' },
    });
  });

  it('returns 400 when workerId is missing', async () => {
    const api = new HttpApi(stubCityLookup as any, { getOrigin: () => null } as any, stubPersistenceLookup as any);
    api.setSessionLookup({ findSession: () => undefined, getAllSessions: () => [] });
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: null, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
    } as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/start', {});
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Missing workerId');
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
      findSession: (sessionId: string) => (sessionId === remoteSession.id ? remoteSession : undefined),
      getAllSessions: () => [remoteSession],
    });
    api.setMeetingBridge({
      getState: () => ({ activeMeeting: null, lastMeeting: null }),
      start: vi.fn(),
      stop: vi.fn(),
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
    };

    api.setMeetingBridge(meetingBridge as any);

    const res = await httpRequest(api, 'POST', '/meeting-bridge/stop');
    expect(res.status).toBe(200);
    expect(meetingBridge.stop).toHaveBeenCalledTimes(1);
    expect(res.data.meeting).toEqual({ meetingId: 'meeting-1', status: 'stopped' });
  });
});
