/**
 * Routing tests for the terminal:* WebSocket message types. The handlers
 * themselves are exercised in TerminalStreamManager.test.ts; this file
 * just pins down the JSON wire format and the dispatch path.
 */

import { describe, it, expect, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { MessageRouter } from '../MessageRouter.js';

function makeRouter() {
  const handlers = {
    onFocus: vi.fn(),
    onGetFibers: vi.fn(),
    onHandoff: vi.fn(),
    onNewWorker: vi.fn(),
    onPinCity: vi.fn(),
    onUnpinCity: vi.fn(),
    onConfirmUnpin: vi.fn(),
    onKillWorker: vi.fn(),
    onSearchFiles: vi.fn(),
    onMoveCity: vi.fn(),
    onListDirectory: vi.fn(),
    onTerminalAttach: vi.fn(),
    onTerminalDetach: vi.fn(),
  };
  const router = new MessageRouter(handlers);
  return { router, handlers };
}

describe('MessageRouter terminal messages', () => {
  const ws = {} as WebSocket;

  it('routes terminal:attach to onTerminalAttach with sessionId', () => {
    const { router, handlers } = makeRouter();
    router.routeClientMessage(ws, JSON.stringify({ type: 'terminal:attach', sessionId: 's1' }));
    expect(handlers.onTerminalAttach).toHaveBeenCalledWith(ws, 's1');
    expect(handlers.onTerminalDetach).not.toHaveBeenCalled();
  });

  it('routes terminal:detach to onTerminalDetach with sessionId', () => {
    const { router, handlers } = makeRouter();
    router.routeClientMessage(ws, JSON.stringify({ type: 'terminal:detach', sessionId: 's1' }));
    expect(handlers.onTerminalDetach).toHaveBeenCalledWith(ws, 's1');
    expect(handlers.onTerminalAttach).not.toHaveBeenCalled();
  });

  it('does not crash on malformed terminal messages', () => {
    const { router } = makeRouter();
    expect(() => router.routeClientMessage(ws, '{"type":"terminal:attach"}')).not.toThrow();
  });
});
