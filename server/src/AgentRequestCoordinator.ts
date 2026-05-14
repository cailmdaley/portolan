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
  originName?: string;
  sshHost?: string;
  agentRuntime?: string;
  agentOnce?: boolean;
  socketCount?: number;
  type: string;
  startedAt: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export type AgentRequestCompletionStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'disconnect'
  | 'send_error'
  | 'unavailable';

export interface AgentRequestCompletionDiagnostic {
  correlationId: string;
  originId: string;
  originName?: string;
  sshHost?: string;
  agentRuntime?: string;
  agentOnce?: boolean;
  socketCount?: number;
  type: string;
  status: AgentRequestCompletionStatus;
  durationMs: number;
  completedAt: number;
  error?: string;
}

export interface AgentRequestCoordinatorOptions {
  /** Default request timeout in ms. Overridable per-call. */
  defaultTimeoutMs?: number;
  now?: () => number;
  maxRecentCompletions?: number;
}

export interface AgentRequestDiagnostic {
  correlationId: string;
  originId: string;
  originName?: string;
  sshHost?: string;
  agentRuntime?: string;
  agentOnce?: boolean;
  socketCount?: number;
  type: string;
  ageMs: number;
}

export interface AgentRequestDiagnostics {
  pending: number;
  byOrigin: Array<{ originId: string; pending: number }>;
  byType: Array<{ type: string; pending: number }>;
  requests: AgentRequestDiagnostic[];
  recent: AgentRequestCompletionDiagnostic[];
  malformedResults: number;
}

export class AgentRequestCoordinator {
  private pending = new Map<string, PendingRequest>();
  private recentCompletions: AgentRequestCompletionDiagnostic[] = [];
  private malformedResultFrames = 0;
  private readonly defaultTimeoutMs: number;
  private readonly maxRecentCompletions: number;
  private readonly now: () => number;

  constructor(
    private originManager: OriginManager,
    options: AgentRequestCoordinatorOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.maxRecentCompletions = options.maxRecentCompletions ?? 20;
    this.now = options.now ?? Date.now;
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
        const message = `unknown origin: ${originId}`;
        this.recordSyntheticCompletion(originId, type, 'unavailable', message);
        reject(new Error(message));
        return;
      }
      const ws = [...origin.agentSockets].find(s => s.readyState === WebSocket.OPEN);
      if (!ws) {
        const message = `origin ${originId} has no connected agent`;
        this.recordSyntheticCompletion(originId, type, 'unavailable', message, origin);
        reject(new Error(message));
        return;
      }
      const correlationId = randomUUID();
      const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
      const timeoutHandle = setTimeout(() => {
        const entry = this.pending.get(correlationId);
        if (entry) {
          this.pending.delete(correlationId);
          this.recordCompletion(entry, 'timeout', "remote agent didn't acknowledge");
          reject(new Error("remote agent didn't acknowledge"));
        }
      }, effectiveTimeout);
      // Don't keep the event loop alive solely for a pending request.
      timeoutHandle.unref?.();

      this.pending.set(correlationId, {
        correlationId,
        originId,
        ...originDiagnosticFields(origin),
        type,
        startedAt: this.now(),
        resolve: resolve as (r: unknown) => void,
        reject,
        timeoutHandle,
      });

      try {
        ws.send(JSON.stringify({ type, payload: { correlationId, ...payload } }));
      } catch (err) {
        clearTimeout(timeoutHandle);
        const entry = this.pending.get(correlationId);
        if (entry) {
          this.pending.delete(correlationId);
          this.recordCompletion(entry, 'send_error', err instanceof Error ? err.message : String(err));
        }
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
      this.recordCompletion(entry, 'ok');
      entry.resolve(result);
    } else {
      const message = error ?? 'remote operation failed';
      this.recordCompletion(entry, 'error', message);
      entry.reject(new Error(message));
    }
  }

  /**
   * Parse a raw `*-result` frame payload from the Rust/WebSocket protocol.
   * This keeps result handling centralized and rejects malformed envelopes
   * early, so protocol drift fails loudly in diagnostics rather than only
   * via timeouts.
   */
  handleResultFrame(type: string, rawPayload: unknown): boolean {
    if (!isRecord(rawPayload)) {
      this.recordMalformedResult(type, undefined, 'result payload must be an object');
      return false;
    }

    const { correlationId, ok, error, ...result } = rawPayload;
    if (typeof correlationId !== 'string' || correlationId.length === 0) {
      this.recordMalformedResult(type, undefined, `malformed ${type}: missing correlationId`);
      return false;
    }
    if (typeof ok !== 'boolean') {
      this.recordMalformedResult(
        type,
        correlationId,
        `malformed ${type}: expected boolean ok flag`,
      );
      const message = typeof error === 'string'
        ? error
        : `malformed ${type}: expected boolean ok flag`;
      this.handleResult(
        correlationId,
        false,
        result as Record<string, unknown>,
        message,
      );
      return true;
    }

    this.handleResult(
      correlationId,
      ok,
      result as Record<string, unknown>,
      typeof error === 'string' ? error : undefined,
    );
    return true;
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
      const message = `agent for ${originId} disconnected`;
      this.recordCompletion(entry, 'disconnect', message);
      entry.reject(new Error(message));
    }
  }

  /** Test/observability hook — number of in-flight requests. */
  getPendingCount(): number {
    return this.pending.size;
  }

  getDiagnostics(): AgentRequestDiagnostics {
    const now = this.now();
    const byOrigin = new Map<string, number>();
    const byType = new Map<string, number>();
    const requests = Array.from(this.pending.values()).map((entry) => {
      byOrigin.set(entry.originId, (byOrigin.get(entry.originId) ?? 0) + 1);
      byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);
      return {
        correlationId: entry.correlationId,
        originId: entry.originId,
        ...originDiagnosticFields(entry),
        type: entry.type,
        ageMs: Math.max(0, now - entry.startedAt),
      };
    });

    const sortCounts = <T extends { pending: number } & Record<string, unknown>>(
      left: T,
      right: T,
      key: keyof T,
    ) => right.pending - left.pending || String(left[key]).localeCompare(String(right[key]));

    return {
      pending: this.pending.size,
      byOrigin: Array.from(byOrigin.entries())
        .map(([originId, pending]) => ({ originId, pending }))
        .sort((a, b) => sortCounts(a, b, 'originId')),
      byType: Array.from(byType.entries())
        .map(([type, pending]) => ({ type, pending }))
        .sort((a, b) => sortCounts(a, b, 'type')),
      requests: requests.sort((a, b) =>
        b.ageMs - a.ageMs || a.originId.localeCompare(b.originId) || a.type.localeCompare(b.type),
      ),
      recent: [...this.recentCompletions],
      malformedResults: this.malformedResultFrames,
    };
  }

  private recordMalformedResult(type: string, correlationId: string | undefined, reason: string): void {
    this.malformedResultFrames += 1;
    console.warn(
      `[AgentRequestCoordinator] malformed ${type} frame ` +
        `(correlationId=${correlationId ?? 'n/a'}): ${reason}`,
    );
  }

  private recordCompletion(
    entry: PendingRequest,
    status: AgentRequestCompletionStatus,
    error?: string,
  ): void {
    const completedAt = this.now();
    this.recentCompletions.unshift({
      correlationId: entry.correlationId,
      originId: entry.originId,
      ...originDiagnosticFields(entry),
      type: entry.type,
      status,
      durationMs: Math.max(0, completedAt - entry.startedAt),
      completedAt,
      ...(error ? { error } : {}),
    });
    if (this.recentCompletions.length > this.maxRecentCompletions) {
      this.recentCompletions.length = this.maxRecentCompletions;
    }
  }

  private recordSyntheticCompletion(
    originId: string,
    type: string,
    status: AgentRequestCompletionStatus,
    error: string,
    origin?: OriginLike,
  ): void {
    const completedAt = this.now();
    this.recentCompletions.unshift({
      correlationId: '',
      originId,
      ...(origin ? originDiagnosticFields(origin) : {}),
      type,
      status,
      durationMs: 0,
      completedAt,
      error,
    });
    if (this.recentCompletions.length > this.maxRecentCompletions) {
      this.recentCompletions.length = this.maxRecentCompletions;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface OriginLike {
  originName?: string;
  name?: string;
  sshHost?: string;
  agentRuntime?: string;
  agentOnce?: boolean;
  agentSockets?: Set<WebSocket>;
  socketCount?: number;
}

function originDiagnosticFields(origin: OriginLike) {
  const originName = origin.originName ?? origin.name;
  return {
    ...(originName ? { originName } : {}),
    ...(origin.sshHost ? { sshHost: origin.sshHost } : {}),
    ...(origin.agentRuntime ? { agentRuntime: origin.agentRuntime } : {}),
    ...(origin.agentOnce !== undefined ? { agentOnce: origin.agentOnce } : {}),
    ...(origin.agentSockets ? { socketCount: origin.agentSockets.size } : {}),
    ...(origin.socketCount !== undefined ? { socketCount: origin.socketCount } : {}),
  };
}
