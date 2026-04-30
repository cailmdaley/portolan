/**
 * Shuttle — fiber-as-ticket orchestrator (v0).
 *
 * Watches a configurable queue root under loom's `.felt/` for
 * `constitution`-tagged fibers whose dependencies are tempered, then
 * dispatches one detached worker per eligible fiber via the bundled
 * `shuttle-worker.sh` script.
 *
 * Architecture (see [[ai-futures/portolan/shuttle/constitution-shuttle]]):
 *   - Orchestrator reads, agent writes. Shuttle never edits fibers.
 *   - Constitution tag is the commitment switch.
 *   - `depends_on` is the blocker edge.
 *   - **Shuttle owns its dispatch path; ralph stays untouched.**
 *     Shuttle's worker is single-shot: render the fiber as the system
 *     prompt, run claude once, exit. No inner respawn loop. Symphony's
 *     continuation-retry (§7.3) lives here in `tick()` — if the fiber
 *     is still eligible on the next poll, we redispatch.
 *   - In-memory dispatch state. Restart recovery comes from re-reading
 *     the fiber tree and probing tmux.
 *
 * Why scoped: many constitution-tagged fibers already exist across
 * loom from before Shuttle. Auto-dispatching all of them is wrong.
 * v0 is opt-in by directory subtree (e.g. start with the smoke-test
 * ladder under `ai-futures/portolan/shuttle/tests/`); broaden when
 * trust grows.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { Fiber } from './FiberReader.js';
import { getAllFibers } from './FiberReader.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Path to the bundled shuttle-worker script. Resolved relative to this
 * module so it travels with the codebase regardless of where Shuttle
 * is invoked from.
 */
const BUNDLED_WORKER_SCRIPT = fileURLToPath(
  new URL('./shuttle-worker.sh', import.meta.url),
);

export interface ShuttleConfig {
  /**
   * Path to a felt host directory (the parent of `.felt/`). Used as the
   * single host when `feltHosts` is unset (or empty); the worker spawns
   * with this as its cwd.
   */
  feltHost: string;
  /**
   * Multi-host aggregation. When non-empty, Shuttle walks each host's
   * `.felt/` and dedupes by `realpath` of the fiber's md file —
   * mirroring HttpApiKanban so the dispatch surface and the kanban view
   * stay aligned. Each dispatched worker spawns with its contributing
   * host as `cwd`, so `felt show <id>` from inside the worker resolves
   * the fiber correctly even when ids collide across hosts (e.g.
   * `vellum-reader/map` exists both in lightcone-myst-coherence and as
   * a stale entry under loom's portolan subtree).
   *
   * The `?cityId=`-scoped kanban path doesn't affect Shuttle; the
   * server-embedded Shuttle instance owns its own host list.
   */
  feltHosts?: string[];
  /**
   * Optional queue scope. Only fibers whose ID starts with one of these
   * prefixes are considered for dispatch. Empty / undefined means "no
   * scoping" (everything constitution-tagged on the host).
   *
   * v0 default in `defaultShuttleConfig` is the smoke-test ladder. The
   * caller can broaden as confidence grows.
   */
  queuePrefixes?: string[];
  /** Poll interval in ms. */
  pollIntervalMs?: number;
  /**
   * Path to the shuttle-worker script. Defaults to the bundled
   * `shuttle-worker.sh` next to this module.
   */
  shuttleWorkerScript?: string;
  /**
   * Hook for emitting runtime snapshots to UI / logs. Called after each
   * reconcile pass. Optional; defaults to console.log of a summary line.
   */
  onSnapshot?: (snap: ShuttleSnapshot) => void;
  /**
   * Test seam — replaces the actual worker invocation. Returns a
   * synthetic tmux session name. The optional `host` is the host that
   * contributed the fiber via the multi-host walk (single-host mode
   * passes the configured `feltHost`). `agent` is the coding-agent
   * CLI selected by `agentForFiber(fiber.tags)` — tests can assert
   * that codex-tagged fibers dispatch with `'codex'`, etc. When
   * undefined, calls the real `shuttleWorkerScript` with `--agent
   * <agent>` appended.
   */
  spawnShuttleWorker?: (fiberId: string, host: string, agent: DispatchAgent) => string;
  /**
   * Test seam — replaces `listShuttleSessions()`. Returns the set of
   * tmux session names that should be considered "live". When
   * undefined, queries real tmux. Pair with `spawnShuttleWorker` to
   * unit-test kill-and-recover semantics deterministically.
   */
  listSessions?: () => string[];
  /**
   * Stage 7 — per-fiber freshness gate. When supplied, called for each
   * eligible fiber before dispatch. Returns the originIds of any
   * currently-stale remote snapshots that own this fiber. Non-empty
   * means "don't dispatch this tick" — the fiber moves to `blocked`
   * with a "origin stale: …" reason, and Shuttle re-checks on the next
   * poll; when the agent reconnects (snapshot flips back to fresh) the
   * fiber becomes dispatchable again automatically.
   *
   * When undefined (the test default), no freshness check runs and all
   * eligible fibers are dispatched. Wired in production to
   * `FiberTreeSnapshotStore.getStaleOriginsForFiber`.
   */
  staleOriginsForFiber?: (fiberId: string) => string[];
  /**
   * Constitution `shuttle-remote-dispatch` — per-fiber deferral gate.
   * When supplied, called for each eligible fiber before dispatch.
   * Returns the originIds of *connected* remote agents that own the
   * fiber. Non-empty means "this fiber is the agent's responsibility,
   * not ours" — the fiber moves to `blocked` with a "deferred to
   * <originId>" reason. Symmetric to `staleOriginsForFiber`: the
   * stale gate covers disconnected remotes (workers may still run
   * autonomously, but we have no fresh visibility), this one covers
   * the steady-state connected remote case.
   *
   * Wired in production to a closure over
   * `FiberTreeSnapshotStore.getOriginsForFiber` filtered by
   * `OriginManager.isOriginConnected` — and skipping the local origin
   * since the server *is* local Shuttle.
   */
  deferredOriginsForFiber?: (fiberId: string) => string[];
}

export function defaultShuttleConfig(overrides: Partial<ShuttleConfig> = {}): ShuttleConfig {
  return {
    feltHost: join(homedir(), 'loom'),
    // No scoping by default — all constitution-tagged, non-draft, unblocked
    // fibers loom-wide are eligible. The original v0 default scoped to the
    // smoke-test ladder as a safety rail while many pre-Shuttle constitution
    // fibers existed; that has been cleaned out, and the `draft` tag is now
    // the per-fiber opt-out. To re-narrow the scope, pass `queuePrefixes`.
    queuePrefixes: undefined,
    pollIntervalMs: 30_000,
    shuttleWorkerScript: BUNDLED_WORKER_SCRIPT,
    ...overrides,
  };
}

// ============================================================================
// Types
// ============================================================================

export type DispatchState = 'idle' | 'running' | 'gone';

/**
 * Coding-agent CLI a worker dispatches into. Selected per-fiber via the
 * `agentForFiber()` predicate; defaults to claude when no override tag
 * is set. Threaded through to `shuttle-worker.sh --agent <agent>` so
 * the shell side can pick the right CLI invocation.
 */
export type DispatchAgent = 'claude' | 'codex';

/**
 * Map a fiber's tags to the dispatch agent. The constitution's
 * `codex` tag is the elegant equivalent of "use codex for this one";
 * `claude` is implicit (no tag needed) but accepted for symmetry.
 *
 * Tag-based rather than a new frontmatter field: tags are felt's
 * primary classification primitive, already discoverable on the
 * kanban card, no schema change. Mirrors how `draft` opts a
 * constitution out of dispatch — same surface, same shape.
 */
export function agentForFiber(tags?: string[]): DispatchAgent {
  if (tags?.includes('codex')) return 'codex';
  return 'claude';
}

export interface DispatchEntry {
  fiberId: string;
  /** tmux session name (set once a worker is spawned). */
  tmuxSession?: string;
  state: DispatchState;
  /** ms since epoch when the worker was first spawned this lifetime. */
  startedAt?: number;
  /**
   * Coding-agent the worker dispatched into. Surfaces "running on
   * codex" badging in the kanban without inventing a new data path.
   * Set when a worker is spawned (or adopted); undefined for
   * blocked / spawn-failed entries.
   */
  agent?: DispatchAgent;
  /**
   * Reason an eligible fiber is *not* running. Useful for the UI; only
   * populated in the snapshot, not stored on the entry itself.
   */
  reason?: string;
}

export interface ShuttleSnapshot {
  /** ms since epoch */
  pollAt: number;
  eligible: DispatchEntry[];
  blocked: Array<{ fiberId: string; reason: string }>;
  /** tmux sessions matching `shuttle-*` that we don't have in state (orphans). */
  orphans: string[];
}

// ============================================================================
// Eligibility predicate
// ============================================================================

/**
 * Eligibility per the constitution:
 *   1. tags includes 'constitution'
 *   2. all `depends_on` references resolve to fibers with `tempered: true`
 *   3. status != 'closed'
 *
 * Plus the v0 scoping rule: id must start with one of `queuePrefixes`
 * (when set).
 *
 * Pure function — no I/O. Caller supplies the full fiber list.
 */
export function computeEligibility(
  fibers: Fiber[],
  queuePrefixes?: string[],
): { eligible: Fiber[]; blocked: Array<{ fiber: Fiber; reason: string }> } {
  const byId = new Map(fibers.map(f => [f.id, f]));
  const eligible: Fiber[] = [];
  const blocked: Array<{ fiber: Fiber; reason: string }> = [];

  const inScope = (id: string): boolean => {
    if (!queuePrefixes || queuePrefixes.length === 0) return true;
    return queuePrefixes.some(p => id === p || id.startsWith(p + '/'));
  };

  for (const f of fibers) {
    if (!f.tags?.includes('constitution')) continue;
    if (!inScope(f.id)) continue;
    // `draft` is a kanban-side opt-out: a fiber tagged constitution+draft is
    // committed-to-eventually but not yet ready to dispatch (the user is still
    // refining it). Treat as blocked so the dispatcher doesn't pick it up.
    // See ai-futures/portolan/shuttle/constitution-shuttle.
    if (f.tags?.includes('draft')) {
      blocked.push({ fiber: f, reason: 'tag: draft' });
      continue;
    }
    if (f.status === 'closed') {
      blocked.push({ fiber: f, reason: 'status: closed' });
      continue;
    }
    const deps = f.dependsOn ?? [];
    const unsatisfied = deps.filter(depId => {
      const dep = byId.get(depId);
      return !dep || dep.tempered !== true;
    });
    if (unsatisfied.length > 0) {
      blocked.push({
        fiber: f,
        reason: `blocked on: ${unsatisfied.join(', ')}`,
      });
      continue;
    }
    eligible.push(f);
  }

  return { eligible, blocked };
}

// ============================================================================
// Tmux probing
// ============================================================================

/** Returns the set of tmux session names matching `shuttle-*`. */
export function listShuttleSessions(): string[] {
  try {
    const out = execSync('tmux ls -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(s => s.startsWith('shuttle-'));
  } catch {
    return [];
  }
}

export function shuttleSessionName(fiberId: string): string {
  return `shuttle-${fiberId}`;
}

// ============================================================================
// Shuttle class
// ============================================================================

export class Shuttle {
  private config: Required<Omit<ShuttleConfig, 'spawnShuttleWorker' | 'onSnapshot' | 'queuePrefixes' | 'listSessions' | 'feltHosts' | 'staleOriginsForFiber' | 'deferredOriginsForFiber'>>
    & Pick<ShuttleConfig, 'spawnShuttleWorker' | 'onSnapshot' | 'queuePrefixes' | 'listSessions' | 'feltHosts' | 'staleOriginsForFiber' | 'deferredOriginsForFiber'>;
  private dispatched = new Map<string, DispatchEntry>();
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshot: ShuttleSnapshot | null = null;
  /**
   * Per-origin agent-pushed snapshots. Constitution
   * `shuttle-remote-dispatch`: each connected remote agent pushes its
   * own `ShuttleSnapshot` periodically; we store the latest per-origin
   * for the kanban / debug composite view. The local Shuttle's own
   * tick result lives in `lastSnapshot`; remotes live here.
   */
  private remoteSnapshots = new Map<string, ShuttleSnapshot>();

  constructor(config: ShuttleConfig) {
    const cfg = { ...defaultShuttleConfig(), ...config };
    if (!cfg.feltHost) throw new Error('Shuttle: feltHost is required');
    if (cfg.shuttleWorkerScript && !cfg.spawnShuttleWorker && !existsSync(cfg.shuttleWorkerScript)) {
      console.warn(
        `[Shuttle] worker script not found at ${cfg.shuttleWorkerScript}; dispatch will fail until a spawnShuttleWorker hook is wired.`,
      );
    }
    this.config = cfg as typeof this.config;
  }

  /** One reconcile pass: read, compute, dispatch, snapshot. Async because fiber walk is async. */
  async tick(): Promise<ShuttleSnapshot> {
    // Multi-host walk + realpath dedupe — same merge HttpApiKanban uses.
    // Each merged entry carries the host that contributed it; dispatch uses
    // that host as the worker's cwd so `felt show <id>` from inside the
    // worker resolves the fiber correctly even when ids collide across
    // hosts.
    const merged = await this.collectFibers();
    const fibers = merged.map(({ fiber }) => fiber);
    const hostByFiberId = new Map(merged.map(({ fiber, host }) => [fiber.id, host]));
    const { eligible: rawEligible, blocked } = computeEligibility(fibers, this.config.queuePrefixes);

    // Stage 7 + remote-dispatch deferral — partition eligible fibers
    // by remote ownership before dispatch.
    //
    //   stale gate    → owning remote agent is disconnected; suspend.
    //   deferred gate → owning remote agent is connected; the agent
    //                   will dispatch on its own host.
    //
    // Either way, the local server does not spawn a worker. Reasons
    // are distinct so the snapshot legibly explains why we paused.
    const eligible: Fiber[] = [];
    const staleOrigins = this.config.staleOriginsForFiber;
    const deferredOrigins = this.config.deferredOriginsForFiber;
    for (const f of rawEligible) {
      const stale = staleOrigins ? staleOrigins(f.id) : [];
      if (stale.length > 0) {
        blocked.push({ fiber: f, reason: `origin stale: ${stale.join(', ')}` });
        continue;
      }
      const deferred = deferredOrigins ? deferredOrigins(f.id) : [];
      if (deferred.length > 0) {
        blocked.push({ fiber: f, reason: `deferred to ${deferred.join(', ')}` });
        continue;
      }
      eligible.push(f);
    }

    const liveSessions = new Set(
      this.config.listSessions ? this.config.listSessions() : listShuttleSessions(),
    );
    const eligibleIds = new Set(eligible.map(f => f.id));

    // Reconcile in-memory state with reality.
    for (const [id, entry] of this.dispatched) {
      if (entry.tmuxSession && !liveSessions.has(entry.tmuxSession)) {
        // Worker exited (cleanly or otherwise). Mark gone — if the fiber
        // is still eligible, we'll redispatch on the next tick. If it
        // closed itself, it won't reappear.
        entry.state = 'gone';
      }
      if (!eligibleIds.has(id)) {
        // No longer eligible: forget the entry. The worker is single-shot,
        // so the tmux session has either ended naturally or will be
        // observed as a gone-state on the next poll.
        this.dispatched.delete(id);
      }
    }

    // Dispatch eligible fibers we don't already have a live worker for.
    const entries: DispatchEntry[] = [];
    for (const f of eligible) {
      const expectedSession = shuttleSessionName(f.id);
      const existing = this.dispatched.get(f.id);
      const sessionLive = existing?.tmuxSession && liveSessions.has(existing.tmuxSession);

      if (sessionLive) {
        entries.push(existing!);
        continue;
      }

      const agent = agentForFiber(f.tags);

      // Adopt an external shuttle session if it already matches by name —
      // covers the case where the user (or a previous Shuttle process)
      // launched the same fiber manually.
      if (liveSessions.has(expectedSession)) {
        const adopted: DispatchEntry = {
          fiberId: f.id,
          tmuxSession: expectedSession,
          state: 'running',
          startedAt: existing?.startedAt ?? Date.now(),
          agent,
          reason: 'adopted existing tmux session',
        };
        this.dispatched.set(f.id, adopted);
        entries.push(adopted);
        continue;
      }

      // Spawn — single-shot. Worker exits when the agent exits; we'll
      // observe the session as gone on a future tick and (if still
      // eligible) redispatch. Agent (claude vs codex) is derived from
      // tags via `agentForFiber()` and threaded into the worker
      // invocation as `--agent <agent>`.
      const host = hostByFiberId.get(f.id) ?? this.config.feltHost;
      try {
        const session = this.spawn(f.id, host, agent);
        const entry: DispatchEntry = {
          fiberId: f.id,
          tmuxSession: session,
          state: 'running',
          startedAt: Date.now(),
          agent,
        };
        this.dispatched.set(f.id, entry);
        entries.push(entry);
      } catch (err: unknown) {
        const msg = (err as { message?: string })?.message ?? String(err);
        entries.push({
          fiberId: f.id,
          state: 'idle',
          agent,
          reason: `spawn failed: ${msg}`,
        });
        console.error(`[Shuttle] spawn failed for ${f.id}:`, msg);
      }
    }

    // Orphans: shuttle-* sessions not tracked by us.
    const trackedSessions = new Set(
      Array.from(this.dispatched.values())
        .map(e => e.tmuxSession)
        .filter((s): s is string => !!s),
    );
    const orphans = Array.from(liveSessions).filter(s => !trackedSessions.has(s));

    const snap: ShuttleSnapshot = {
      pollAt: Date.now(),
      eligible: entries,
      blocked: blocked.map(b => ({ fiberId: b.fiber.id, reason: b.reason })),
      orphans,
    };
    this.lastSnapshot = snap;
    if (this.config.onSnapshot) {
      this.config.onSnapshot(snap);
    } else {
      console.log(
        `[Shuttle] tick: ${entries.length} eligible, ${blocked.length} blocked, ${orphans.length} orphans`,
      );
    }
    return snap;
  }

  /** Start the polling loop. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  /** Stop the polling loop. Does NOT kill running workers — they own their lifecycle. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): ShuttleSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Constitution `shuttle-remote-dispatch` — record a remote agent's
   * latest dispatch snapshot. Called from the WebSocket handler when a
   * `shuttle_snapshot` message lands. Replaces any prior snapshot for
   * that origin wholesale (push is idempotent on the wire — agent
   * always ships its full eligible/blocked/orphans).
   */
  setRemoteSnapshot(originId: string, snapshot: ShuttleSnapshot): void {
    this.remoteSnapshots.set(originId, snapshot);
  }

  /**
   * Drop the per-origin remote snapshot, e.g. when an agent
   * disconnects. The kanban can choose to render last-known-good
   * instead — that's a UI decision, not a Shuttle one.
   */
  clearRemoteSnapshot(originId: string): void {
    this.remoteSnapshots.delete(originId);
  }

  /**
   * Map of every remote origin's most recent snapshot. The kanban
   * composes this with the local snapshot (`getSnapshot()`) to produce
   * a unified per-origin picture without inventing new transport.
   */
  getRemoteSnapshots(): Map<string, ShuttleSnapshot> {
    return new Map(this.remoteSnapshots);
  }

  /**
   * Composite snapshot: local + every connected remote, keyed by
   * originId. `local` is always present (even if null when the first
   * tick hasn't run yet). Useful for `/debug-runtime` and for the
   * kanban frontend's per-origin badging.
   */
  getCompositeSnapshot(): { local: ShuttleSnapshot | null; remote: Record<string, ShuttleSnapshot> } {
    const remote: Record<string, ShuttleSnapshot> = {};
    for (const [originId, snap] of this.remoteSnapshots) remote[originId] = snap;
    return { local: this.lastSnapshot, remote };
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /** Hosts to walk for the eligibility pass + worker dispatch. */
  private resolveHosts(): string[] {
    const explicit = this.config.feltHosts;
    if (explicit && explicit.length > 0) return explicit;
    return [this.config.feltHost];
  }

  /** Path to the fiber's md inside a given felt host. */
  private fiberPath(host: string, f: Fiber): string {
    const segments = f.id.split('/');
    const basename = segments[segments.length - 1];
    return f.isRoot
      ? join(host, '.felt', `${basename}.md`)
      : join(host, '.felt', f.id, `${basename}.md`);
  }

  /**
   * Walk every configured host, parse fibers, and dedupe by realpath of
   * the fiber's md file. First-seen host wins, in `resolveHosts()` order;
   * the contributing host threads through dispatch as the worker's cwd.
   *
   * Mirrors HttpApiKanban.collectFibers — keeping the kanban's view and
   * Shuttle's dispatch surface aligned by construction.
   */
  private async collectFibers(): Promise<Array<{ fiber: Fiber; host: string }>> {
    const seen = new Map<string, { fiber: Fiber; host: string }>();
    for (const host of this.resolveHosts()) {
      if (!existsSync(join(host, '.felt'))) continue;
      let fibers: Fiber[];
      try {
        fibers = await getAllFibers(host);
      } catch (err) {
        console.error(`[Shuttle] getAllFibers failed for host ${host}:`, err);
        continue;
      }
      for (const f of fibers) {
        const path = this.fiberPath(host, f);
        let canonical: string;
        try {
          canonical = realpathSync(path);
        } catch {
          continue;
        }
        if (!seen.has(canonical)) seen.set(canonical, { fiber: f, host });
      }
    }
    return [...seen.values()];
  }

  private spawn(fiberId: string, host: string, agent: DispatchAgent): string {
    if (this.config.spawnShuttleWorker) {
      return this.config.spawnShuttleWorker(fiberId, host, agent);
    }
    const script = this.config.shuttleWorkerScript;
    if (!script || !existsSync(script)) {
      throw new Error(`shuttle-worker not available at ${script}`);
    }
    // The worker resolves the fiber via `felt show` from `cwd`; using the
    // contributing host means the right `.felt/` is in scope, even when
    // ids collide across hosts (multi-host gotcha — see
    // gotcha-kanban-fiber-id-collisions-across-cities).
    const result = spawnSync(script, [fiberId, '--agent', agent], {
      cwd: host,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(
        `shuttle-worker failed (status ${result.status}): ${result.stderr || result.stdout}`,
      );
    }
    return shuttleSessionName(fiberId);
  }
}

// ============================================================================
// Convenience: confirm the felt host has a `.felt/` directory
// ============================================================================

export function isValidFeltHost(path: string): boolean {
  const feltDir = join(path, '.felt');
  try {
    return existsSync(feltDir) && statSync(feltDir).isDirectory();
  } catch {
    return false;
  }
}
