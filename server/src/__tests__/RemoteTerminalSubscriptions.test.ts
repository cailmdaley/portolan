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

    table.set(first, 'session-a', { originId: 'remote-candide', subscriptionId: 'sub-a' });
    table.set(second, 'session-b', { originId: 'remote-candide', subscriptionId: 'sub-b' });

    table.routeBytes('remote-candide', 'sub-a', 'Ynl0ZXM=');
    table.routeExit('remote-candide', 'sub-a', 'pane exited');

    expect(sentFrames(first)).toEqual([
      { type: 'terminal:bytes', sessionId: 'session-a', bytes: 'Ynl0ZXM=' },
      { type: 'terminal:exit', sessionId: 'session-a', reason: 'pane exited' },
    ]);
    expect(sentFrames(second)).toEqual([]);
    expect(table.getStats()).toEqual([{
      originId: 'remote-candide',
      browserClients: 1,
      subscriptions: 1,
    }]);
  });

  it('closes every subscription for a disconnected agent origin', () => {
    const table = new RemoteTerminalSubscriptions();
    const first = fakeSocket();
    const second = fakeSocket();

    table.set(first, 'candide-a', { originId: 'remote-candide', subscriptionId: 'sub-a' });
    table.set(first, 'cineca-a', { originId: 'remote-cineca', subscriptionId: 'sub-c' });
    table.set(second, 'candide-b', { originId: 'remote-candide', subscriptionId: 'sub-b' });

    table.closeOrigin('remote-candide', 'agent disconnected: candide');

    expect(sentFrames(first)).toEqual([
      { type: 'terminal:exit', sessionId: 'candide-a', reason: 'agent disconnected: candide' },
    ]);
    expect(sentFrames(second)).toEqual([
      { type: 'terminal:exit', sessionId: 'candide-b', reason: 'agent disconnected: candide' },
    ]);
    expect(table.getStats()).toEqual([{
      originId: 'remote-cineca',
      browserClients: 1,
      subscriptions: 1,
    }]);
  });
});
