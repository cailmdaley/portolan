/**
 * AgentRequestCoordinator — request/response layer over the agent WebSocket.
 *
 * Stage 4 of [[ai-futures/portolan/vellum-reader/constitution-vellum-kanban]].
 *
 * The existing agent ↔ server protocol is fire-and-forget in both directions
 * (sessions update, activity, fiber-tree dump/delta). Some flows — kanban
 * mutation being the first — need a round-trip: the server initiates, the
 * agent acknowledges with success/failure. This module owns the correlation-ID
 * pattern that turns the same WebSocket into a request/response surface
 * without changing the transport.
 *
 * Each `send` generates a UUID, registers a pending entry, and writes the
 * outgoing frame as `{type, payload: {correlationId, ...payload}}`. The agent
 * replies with `{type: '<original-type>-result', payload: {correlationId,
 * ok, error?, ...result}}`; the server's WebSocket router calls
 * `handleResult` to resolve the matching entry. A 5s default timeout protects
 * against silently-dead agents; `drainOnDisconnect` rejects all entries for
 * an origin when its socket closes mid-flight.
 *
 * The coordinator is generic — `kanban-transition` is the first user but the
 * shape extends naturally to any future server → agent request (e.g. the
 * lazy-artifact-fetch protocol flagged in the constitution's out-of-scope
 * siblings).
 */

import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import type { OriginManager } from './OriginManager.js';

interface PendingRequest {
  correlationId: string;
  originId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface AgentRequestCoordinatorOptions {
  /** Default request timeout in ms. Overridable per-call. */
  defaultTimeoutMs?: number;
}

export class AgentRequestCoordinator {
  private pending = new Map<string, PendingRequest>();
  private readonly defaultTimeoutMs: number;

  constructor(
    private originManager: OriginManager,
    options: AgentRequestCoordinatorOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
  }

  /**
   * Send a request to the agent for `originId` and resolve when the matching
   * `*-result` message lands. Rejects if:
   *   - the origin isn't registered
   *   - the origin has no connected agent socket
   *   - the agent doesn't reply within `timeoutMs` (default 5s)
   *   - the agent disconnects before replying
   *   - the agent replies with `{ok: false, error}`
   *
   * The result type `T` is the *payload of the agent's reply minus the
   * `correlationId`/`ok`/`error` envelope* — i.e. whatever fields the agent
   * sends alongside `ok: true`. For `kanban-transition` that's `{content?:
   * string}` carrying the post-write file content for the snapshot to apply
   * eagerly.
   */
  send<T = unknown>(
    originId: string,
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const origin = this.originManager.getOrigin(originId);
      if (!origin) {
        reject(new Error(`unknown origin: ${originId}`));
        return;
      }
      const ws = [...origin.agentSockets].find(s => s.readyState === WebSocket.OPEN);
      if (!ws) {
        reject(new Error(`origin ${originId} has no connected agent`));
        return;
      }
      const correlationId = randomUUID();
      const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
      const timeoutHandle = setTimeout(() => {
        if (this.pending.delete(correlationId)) {
          reject(new Error("remote agent didn't acknowledge"));
        }
      }, effectiveTimeout);
      // Don't keep the event loop alive solely for a pending request.
      timeoutHandle.unref?.();

      this.pending.set(correlationId, {
        correlationId,
        originId,
        resolve: resolve as (r: unknown) => void,
        reject,
        timeoutHandle,
      });

      try {
        ws.send(JSON.stringify({ type, payload: { correlationId, ...payload } }));
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pending.delete(correlationId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Route an agent's reply. Called from `index.ts`'s WebSocket message router
   * when a `*-result` message arrives. Unknown correlationIds are logged and
   * dropped — they typically mean a timeout already rejected the entry, or
   * the agent is replaying after a server restart.
   */
  handleResult(
    correlationId: string,
    ok: boolean,
    result: Record<string, unknown> = {},
    error?: string,
  ): void {
    const entry = this.pending.get(correlationId);
    if (!entry) {
      console.warn(
        `[AgentRequestCoordinator] result for unknown correlationId=${correlationId} ` +
          `(timed out or stale)`,
      );
      return;
    }
    clearTimeout(entry.timeoutHandle);
    this.pending.delete(correlationId);
    if (ok) {
      entry.resolve(result);
    } else {
      entry.reject(new Error(error ?? 'remote operation failed'));
    }
  }

  /**
   * Reject every pending entry for `originId`. Called from the WebSocket
   * close handler so callers don't hang on a dead agent — they get an
   * immediate "agent disconnected" rejection instead of a 5s timeout wait.
   */
  drainOnDisconnect(originId: string): void {
    for (const [correlationId, entry] of this.pending) {
      if (entry.originId !== originId) continue;
      clearTimeout(entry.timeoutHandle);
      this.pending.delete(correlationId);
      entry.reject(new Error(`agent for ${originId} disconnected`));
    }
  }

  /** Test/observability hook — number of in-flight requests. */
  getPendingCount(): number {
    return this.pending.size;
  }
}
