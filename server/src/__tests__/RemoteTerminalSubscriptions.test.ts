import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RemoteTerminalSubscriptions } from '../RemoteTerminalSubscriptions.js';

function fakeSocket(open = true): WebSocket {
  return {
    OPEN: 1,
    readyState: open ? 1 : 3,
    send: vi.fn(),
  } as unknown as WebSocket;
}

function sentFrames(ws: WebSocket): unknown[] {
  return (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) =>
    JSON.parse(String(raw)),
  );
}

describe('RemoteTerminalSubscriptions', () => {
  it('routes bytes and exits only to the matching subscription', () => {
    const table = new RemoteTerminalSubscriptions();
    const first = fakeSocket();
    const second = fakeSocket();

    table.set(first, 'session-a', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker-a' });
    table.set(second, 'session-b', { originId: 'remote-candide', subscriptionId: 'sub-b', tmuxSession: 'worker-b' });

    table.routeBytes('remote-candide', 'sub-a', 'Ynl0ZXM=');
    table.routeExit('remote-candide', 'sub-a', 'pane exited');

    expect(sentFrames(first)).toEqual([
      { type: 'terminal:bytes', sessionId: 'session-a', bytes: 'Ynl0ZXM=' },
      { type: 'terminal:exit', sessionId: 'session-a', reason: 'pane exited' },
    ]);
    expect(sentFrames(second)).toEqual([]);
    expect(table.getStats()).toEqual([{
      originId: 'remote-candide',
      tmuxSession: 'worker-b',
      browserClients: 1,
      browserSessions: 1,
      subscriptions: 1,
    }]);
  });

  it('never routes remote frames to a replaced browser session subscription', () => {
    const table = new RemoteTerminalSubscriptions();
    const first = fakeSocket();

    table.set(first, 'session-a', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker-a' });
    table.set(first, 'session-a', { originId: 'remote-candide', subscriptionId: 'sub-b', tmuxSession: 'worker-b' });

    table.routeBytes('remote-candide', 'sub-a', 'T2VfZm9yX2FkYQ==');
    table.routeExit('remote-candide', 'sub-a', 'stale');
    table.routeBytes('remote-candide', 'sub-b', 'bmV3LXRleHQ=');

    expect(sentFrames(first)).toEqual([
      { type: 'terminal:bytes', sessionId: 'session-a', bytes: 'bmV3LXRleHQ=' },
    ]);
    expect(table.getTargetSubscriptionId('remote-candide', 'worker-a')).toBeUndefined();
    expect(table.getTargetSubscriptionId('remote-candide', 'worker-b')).toEqual('sub-b');
  });

  it('fans one remote backing subscription out to multiple browser sessions', () => {
    const table = new RemoteTerminalSubscriptions();
    const first = fakeSocket();
    const second = fakeSocket();

    table.set(first, 'session-a', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker' });
    table.set(first, 'session-a-copy', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker' });
    table.set(second, 'session-b', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker' });

    table.routeBytes('remote-candide', 'sub-a', 'Ynl0ZXM=');

    expect(sentFrames(first)).toEqual([
      { type: 'terminal:bytes', sessionId: 'session-a', bytes: 'Ynl0ZXM=' },
      { type: 'terminal:bytes', sessionId: 'session-a-copy', bytes: 'Ynl0ZXM=' },
    ]);
    expect(sentFrames(second)).toEqual([
      { type: 'terminal:bytes', sessionId: 'session-b', bytes: 'Ynl0ZXM=' },
    ]);
    expect(table.getStats()).toEqual([{
      originId: 'remote-candide',
      tmuxSession: 'worker',
      browserClients: 2,
      browserSessions: 3,
      subscriptions: 1,
    }]);
  });

  it('routes exit once, then drops stale routing for that remote subscription', () => {
    const table = new RemoteTerminalSubscriptions();
    const first = fakeSocket();
    const second = fakeSocket();

    table.set(first, 'session-a', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker' });
    table.set(second, 'session-b', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker' });

    table.routeExit('remote-candide', 'sub-a', 'terminated');
    table.routeBytes('remote-candide', 'sub-a', 'Tm90IHNob3dlbi4=');

    expect(sentFrames(first)).toEqual([
      { type: 'terminal:exit', sessionId: 'session-a', reason: 'terminated' },
    ]);
    expect(sentFrames(second)).toEqual([
      { type: 'terminal:exit', sessionId: 'session-b', reason: 'terminated' },
    ]);
    expect(table.getStats()).toEqual([]);
  });

  it('only returns an unsubscribe entry when the last browser session detaches', () => {
    const table = new RemoteTerminalSubscriptions();
    const first = fakeSocket();
    const second = fakeSocket();

    table.set(first, 'session-a', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker' });
    table.set(second, 'session-b', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker' });

    expect(table.delete(first, 'session-a')).toBeUndefined();
    expect(table.delete(second, 'session-b')).toEqual({
      originId: 'remote-candide',
      subscriptionId: 'sub-a',
      tmuxSession: 'worker',
    });
  });

  it('closes every subscription for a disconnected agent origin', () => {
    const table = new RemoteTerminalSubscriptions();
    const first = fakeSocket();
    const second = fakeSocket();

    table.set(first, 'candide-a', { originId: 'remote-candide', subscriptionId: 'sub-a', tmuxSession: 'worker-a' });
    table.set(first, 'cineca-a', { originId: 'remote-cineca', subscriptionId: 'sub-c', tmuxSession: 'worker-c' });
    table.set(second, 'candide-b', { originId: 'remote-candide', subscriptionId: 'sub-b', tmuxSession: 'worker-b' });

    table.closeOrigin('remote-candide', 'agent disconnected: candide');

    expect(sentFrames(first)).toEqual([
      { type: 'terminal:exit', sessionId: 'candide-a', reason: 'agent disconnected: candide' },
    ]);
    expect(sentFrames(second)).toEqual([
      { type: 'terminal:exit', sessionId: 'candide-b', reason: 'agent disconnected: candide' },
    ]);
    expect(table.getStats()).toEqual([{
      originId: 'remote-cineca',
      tmuxSession: 'worker-c',
      browserClients: 1,
      browserSessions: 1,
      subscriptions: 1,
    }]);
    expect(table.getTargetSubscriptionId('remote-candide', 'worker-a')).toBeUndefined();
    expect(table.getTargetSubscriptionId('remote-candide', 'worker-b')).toBeUndefined();
    expect(table.getTargetSubscriptionId('remote-cineca', 'worker-c')).toEqual('sub-c');

    table.routeBytes('remote-candide', 'sub-a', 'bWF0Y2hh');
    table.routeExit('remote-candide', 'sub-a', 'should-never-deliver');
    expect(sentFrames(first)).toEqual([
      { type: 'terminal:exit', sessionId: 'candide-a', reason: 'agent disconnected: candide' },
    ]);
    expect(sentFrames(second)).toEqual([
      { type: 'terminal:exit', sessionId: 'candide-b', reason: 'agent disconnected: candide' },
    ]);
  });
});
