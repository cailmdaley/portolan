/**
 * AgentRequestCoordinator unit tests.
 *
 * Stage 4 of [[ai-futures/portolan/vellum-reader/constitution-vellum-kanban]].
 *
 * Covers the correlation-ID round-trip surface end-to-end with a stub
 * WebSocket: send writes the right frame, handleResult resolves/rejects
 * the matching pending entry, timeouts fire after the configured window,
 * drainOnDisconnect rejects every pending entry for the dropped origin
 * (and leaves other origins alone), and unknown-correlationId replies are
 * dropped quietly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { AgentRequestCoordinator } from '../AgentRequestCoordinator.js';
import { OriginManager } from '../OriginManager.js';

/**
 * Minimal stub satisfying the agent-side WebSocket contract the coordinator
 * uses: `readyState === WebSocket.OPEN` and `send(...)`. Captures every
 * frame for assertion. The coordinator never reads from the ws.
 */
function makeStubWs() {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
  } as unknown as WebSocket;
  return { ws, sent };
}

function lastSent(sent: string[]): {
  type: string;
  payload: { correlationId: string; [k: string]: unknown };
} {
  if (sent.length === 0) throw new Error('no frames sent');
  return JSON.parse(sent[sent.length - 1]);
}

describe('AgentRequestCoordinator', () => {
  let originManager: OriginManager;
  let coord: AgentRequestCoordinator;

  beforeEach(() => {
    originManager = new OriginManager();
  });

  it('rejects when the origin is unregistered', async () => {
    coord = new AgentRequestCoordinator(originManager);
    await expect(coord.send('remote-nonexistent', 'noop', {})).rejects.toThrow(
      /unknown origin/,
    );
  });

  it('rejects when the origin has no connected agent', async () => {
    // Register an agent then disconnect — origin exists but agentSockets is empty.
    const { ws } = makeStubWs();
    originManager.registerAgent('cineca', ws);
    originManager.handleDisconnect(ws);
    coord = new AgentRequestCoordinator(originManager);
    await expect(coord.send('remote-cineca', 'noop', {})).rejects.toThrow(
      /no connected agent/,
    );
  });

  it('sends a correlation-tagged frame to the agent ws', async () => {
    const { ws, sent } = makeStubWs();
    originManager.registerAgent('cineca', ws);
    coord = new AgentRequestCoordinator(originManager);

    const pending = coord.send('remote-cineca', 'kanban-transition', {
      path: 'cmbx/cmbx.md',
      target: 'tempered',
    });
    void pending; // not awaited; we're testing the emitted frame

    const frame = lastSent(sent);
    expect(frame.type).toBe('kanban-transition');
    expect(typeof frame.payload.correlationId).toBe('string');
    expect(frame.payload.correlationId.length).toBeGreaterThan(0);
    expect(frame.payload.path).toBe('cmbx/cmbx.md');
    expect(frame.payload.target).toBe('tempered');
    expect(coord.getPendingCount()).toBe(1);
  });

  it('handleResult({ok: true}) resolves the pending promise with the result body', async () => {
    const { ws, sent } = makeStubWs();
    originManager.registerAgent('cineca', ws);
    coord = new AgentRequestCoordinator(originManager);

    const pending = coord.send<{ content: string }>('remote-cineca', 'kanban-transition', {});
    const correlationId = lastSent(sent).payload.correlationId;
    coord.handleResult(correlationId, true, { content: 'updated body' });

    await expect(pending).resolves.toEqual({ content: 'updated body' });
    expect(coord.getPendingCount()).toBe(0);
  });

  it('handleResult({ok: false}) rejects with the agent-supplied error', async () => {
    const { ws, sent } = makeStubWs();
    originManager.registerAgent('cineca', ws);
    coord = new AgentRequestCoordinator(originManager);

    const pending = coord.send('remote-cineca', 'kanban-transition', {});
    const correlationId = lastSent(sent).payload.correlationId;
    coord.handleResult(correlationId, false, {}, 'fiber file missing');

    await expect(pending).rejects.toThrow(/fiber file missing/);
    expect(coord.getPendingCount()).toBe(0);
  });

  it('times out after defaultTimeoutMs with the documented error', async () => {
    vi.useFakeTimers();
    try {
      const { ws } = makeStubWs();
      originManager.registerAgent('cineca', ws);
      coord = new AgentRequestCoordinator(originManager, { defaultTimeoutMs: 100 });
      const pending = coord.send('remote-cineca', 'kanban-transition', {});
      vi.advanceTimersByTime(150);
      await expect(pending).rejects.toThrow(/didn't acknowledge/);
      expect(coord.getPendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('per-call timeout overrides the default', async () => {
    vi.useFakeTimers();
    try {
      const { ws } = makeStubWs();
      originManager.registerAgent('cineca', ws);
      coord = new AgentRequestCoordinator(originManager, { defaultTimeoutMs: 60_000 });
      const pending = coord.send('remote-cineca', 'kanban-transition', {}, 50);
      vi.advanceTimersByTime(100);
      await expect(pending).rejects.toThrow(/didn't acknowledge/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drainOnDisconnect rejects all pending entries for the dropped origin only', async () => {
    const { ws: cinecaWs, sent: cinecaSent } = makeStubWs();
    const { ws: candideWs, sent: candideSent } = makeStubWs();
    originManager.registerAgent('cineca', cinecaWs);
    originManager.registerAgent('candide', candideWs);
    coord = new AgentRequestCoordinator(originManager);

    const cineca1 = coord.send('remote-cineca', 'kanban-transition', { path: 'a.md' });
    const cineca2 = coord.send('remote-cineca', 'kanban-transition', { path: 'b.md' });
    const candide1 = coord.send('remote-candide', 'kanban-transition', { path: 'c.md' });
    expect(coord.getPendingCount()).toBe(3);

    coord.drainOnDisconnect('remote-cineca');

    await expect(cineca1).rejects.toThrow(/disconnected/);
    await expect(cineca2).rejects.toThrow(/disconnected/);
    expect(coord.getPendingCount()).toBe(1);

    // Candide entry still in flight; resolve it to confirm it survived.
    const candideCorr = JSON.parse(candideSent[0]).payload.correlationId;
    coord.handleResult(candideCorr, true, { content: 'ok' });
    await expect(candide1).resolves.toEqual({ content: 'ok' });
    expect(coord.getPendingCount()).toBe(0);

    // Both ws received their frame (just confirming the test setup).
    expect(cinecaSent.length).toBe(2);
    expect(candideSent.length).toBe(1);
  });

  it('drops unknown correlationId replies without throwing', async () => {
    coord = new AgentRequestCoordinator(originManager);
    expect(() => coord.handleResult('does-not-exist', true, {})).not.toThrow();
  });

  it('a result that arrives after timeout is silently ignored', async () => {
    vi.useFakeTimers();
    try {
      const { ws, sent } = makeStubWs();
      originManager.registerAgent('cineca', ws);
      coord = new AgentRequestCoordinator(originManager, { defaultTimeoutMs: 50 });
      const pending = coord.send('remote-cineca', 'kanban-transition', {});
      const correlationId = lastSent(sent).payload.correlationId;
      vi.advanceTimersByTime(100);
      await expect(pending).rejects.toThrow(/didn't acknowledge/);
      // Late reply doesn't double-resolve.
      expect(() => coord.handleResult(correlationId, true, { content: 'late' })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects synchronously when ws.send throws (e.g. socket already closed)', async () => {
    // Custom stub that throws on send.
    const ws = {
      readyState: WebSocket.OPEN,
      send: () => {
        throw new Error('socket dead');
      },
    } as unknown as WebSocket;
    originManager.registerAgent('cineca', ws);
    coord = new AgentRequestCoordinator(originManager);
    await expect(coord.send('remote-cineca', 'noop', {})).rejects.toThrow(/socket dead/);
    expect(coord.getPendingCount()).toBe(0);
  });

  it('reports pending requests by origin and type for runtime diagnostics', () => {
    let now = 1_000;
    const { ws: cinecaWs } = makeStubWs();
    const { ws: candideWs } = makeStubWs();
    originManager.registerAgent('cineca', cinecaWs);
    originManager.registerAgent('candide', candideWs);
    coord = new AgentRequestCoordinator(originManager, { now: () => now });

    const pending = [
      coord.send('remote-cineca', 'terminal-capture', {}),
      coord.send('remote-cineca', 'file-content', {}),
      coord.send('remote-candide', 'terminal-capture', {}),
    ];
    now = 1_250;

    expect(coord.getDiagnostics()).toEqual({
      pending: 3,
      byOrigin: [
        { originId: 'remote-cineca', pending: 2 },
        { originId: 'remote-candide', pending: 1 },
      ],
      byType: [
        { type: 'terminal-capture', pending: 2 },
        { type: 'file-content', pending: 1 },
      ],
      requests: expect.arrayContaining([
        expect.objectContaining({
          originId: 'remote-cineca',
          type: 'terminal-capture',
          ageMs: 250,
        }),
        expect.objectContaining({
          originId: 'remote-cineca',
          type: 'file-content',
          ageMs: 250,
        }),
        expect.objectContaining({
          originId: 'remote-candide',
          type: 'terminal-capture',
          ageMs: 250,
        }),
      ]),
      recent: [],
    });

    for (const request of pending) {
      request.catch(() => {});
    }
  });

  it('reports recent completed requests with status and duration for diagnostics', async () => {
    let now = 2_000;
    const { ws, sent } = makeStubWs();
    originManager.registerAgent('cineca', ws);
    coord = new AgentRequestCoordinator(originManager, {
      now: () => now,
      maxRecentCompletions: 2,
    });

    const ok = coord.send('remote-cineca', 'file-content', {});
    const okCorrelationId = lastSent(sent).payload.correlationId;
    now = 2_090;
    coord.handleResult(okCorrelationId, true, { content: 'ok' });
    await expect(ok).resolves.toEqual({ content: 'ok' });

    const failed = coord.send('remote-cineca', 'project-file', {});
    const failedCorrelationId = lastSent(sent).payload.correlationId;
    now = 2_150;
    coord.handleResult(failedCorrelationId, false, {}, 'missing file');
    await expect(failed).rejects.toThrow(/missing file/);

    const disconnected = coord.send('remote-cineca', 'terminal-capture', {});
    now = 2_200;
    coord.drainOnDisconnect('remote-cineca');
    await expect(disconnected).rejects.toThrow(/disconnected/);

    expect(coord.getDiagnostics().recent).toEqual([
      expect.objectContaining({
        originId: 'remote-cineca',
        type: 'terminal-capture',
        status: 'disconnect',
        durationMs: 50,
        completedAt: 2_200,
        error: 'agent for remote-cineca disconnected',
      }),
      expect.objectContaining({
        originId: 'remote-cineca',
        type: 'project-file',
        status: 'error',
        durationMs: 60,
        completedAt: 2_150,
        error: 'missing file',
      }),
    ]);
  });

  it('records timed-out requests in recent diagnostics', async () => {
    vi.useFakeTimers();
    try {
      let now = 5_000;
      const { ws } = makeStubWs();
      originManager.registerAgent('cineca', ws);
      coord = new AgentRequestCoordinator(originManager, {
        defaultTimeoutMs: 100,
        now: () => now,
      });

      const pending = coord.send('remote-cineca', 'search-files', {});
      now = 5_150;
      vi.advanceTimersByTime(150);
      await expect(pending).rejects.toThrow(/didn't acknowledge/);

      expect(coord.getDiagnostics().recent).toEqual([
        expect.objectContaining({
          originId: 'remote-cineca',
          type: 'search-files',
          status: 'timeout',
          durationMs: 150,
          error: "remote agent didn't acknowledge",
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
