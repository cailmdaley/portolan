/**
 * Shuttle — fiber-as-ticket orchestrator (v0).
 *
 * Watches a configurable queue root under loom's `.felt/` for
 * `constitution`-tagged fibers whose dependencies are tempered, then
 * dispatches one detached worker per eligible fiber via the bundled
 * ralph launcher.
 *
 * Architecture (see [[ai-futures/portolan/shuttle/constitution-shuttle]]):
 *   - Orchestrator reads, agent writes. Shuttle never edits fibers.
 *   - Constitution tag is the commitment switch.
 *   - `depends_on` is the blocker edge.
 *   - Runner is the bundled ralph launcher (`~/.claude/skills/felt/scripts/ralph`).
 *   - Symphony's continuation-retry IS the ralph loop — the launcher's
 *     own iteration loop handles re-dispatch on clean exit; we just
 *     spawn it and let it run.
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
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Fiber } from './FiberReader.js';
import { getAllFibers } from './FiberReader.js';

// ============================================================================
// Configuration
// ============================================================================

export interface ShuttleConfig {
  /** Path to a felt host directory (the parent of `.felt/`). */
  feltHost: string;
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
  /** Path to the ralph launcher script. */
  ralphScript?: string;
  /**
   * Hook for emitting runtime snapshots to UI / logs. Called after each
   * reconcile pass. Optional; defaults to console.log of a summary line.
   */
  onSnapshot?: (snap: ShuttleSnapshot) => void;
  /**
   * Test seam — replaces the actual launcher invocation. Returns a
   * synthetic tmux session name. When undefined, calls the real
   * `ralphScript`.
   */
  spawnRalph?: (fiberId: string) => string;
}

export function defaultShuttleConfig(overrides: Partial<ShuttleConfig> = {}): ShuttleConfig {
  return {
    feltHost: join(homedir(), 'loom'),
    queuePrefixes: ['ai-futures/portolan/shuttle/tests'],
    pollIntervalMs: 30_000,
    ralphScript: join(homedir(), '.claude', 'skills', 'felt', 'scripts', 'ralph'),
    ...overrides,
  };
}

// ============================================================================
// Types
// ============================================================================

export type DispatchState = 'idle' | 'running' | 'gone';

export interface DispatchEntry {
  fiberId: string;
  /** tmux session name (set once a worker is spawned). */
  tmuxSession?: string;
  state: DispatchState;
  /** ms since epoch when the worker was first spawned this lifetime. */
  startedAt?: number;
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
  /** tmux sessions matching `ralph-*` that we don't have in state (orphans). */
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

/** Returns the set of tmux session names matching `ralph-*`. */
export function listRalphSessions(): string[] {
  try {
    const out = execSync('tmux ls -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(s => s.startsWith('ralph-'));
  } catch {
    return [];
  }
}

export function ralphSessionName(fiberId: string): string {
  return `ralph-${fiberId}`;
}

// ============================================================================
// Shuttle class
// ============================================================================

export class Shuttle {
  private config: Required<Omit<ShuttleConfig, 'spawnRalph' | 'onSnapshot' | 'queuePrefixes'>>
    & Pick<ShuttleConfig, 'spawnRalph' | 'onSnapshot' | 'queuePrefixes'>;
  private dispatched = new Map<string, DispatchEntry>();
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshot: ShuttleSnapshot | null = null;

  constructor(config: ShuttleConfig) {
    const cfg = { ...defaultShuttleConfig(), ...config };
    if (!cfg.feltHost) throw new Error('Shuttle: feltHost is required');
    if (cfg.ralphScript && !cfg.spawnRalph && !existsSync(cfg.ralphScript)) {
      console.warn(
        `[Shuttle] ralph launcher not found at ${cfg.ralphScript}; dispatch will fail until a spawnRalph hook is wired.`,
      );
    }
    this.config = cfg as typeof this.config;
  }

  /** One reconcile pass: read, compute, dispatch, snapshot. Async because fiber walk is async. */
  async tick(): Promise<ShuttleSnapshot> {
    const fibers = await getAllFibers(this.config.feltHost);
    const { eligible, blocked } = computeEligibility(fibers, this.config.queuePrefixes);

    const ralphSessions = new Set(listRalphSessions());
    const eligibleIds = new Set(eligible.map(f => f.id));

    // Reconcile in-memory state with reality.
    for (const [id, entry] of this.dispatched) {
      if (entry.tmuxSession && !ralphSessions.has(entry.tmuxSession)) {
        // Worker exited (cleanly or otherwise). Remove from state — if the
        // fiber is still eligible, we'll redispatch on the next tick. If it
        // closed itself, it won't reappear.
        entry.state = 'gone';
      }
      if (!eligibleIds.has(id)) {
        // No longer eligible: forget the entry. The launcher loop already
        // exits on status flip, so the tmux session will close itself.
        this.dispatched.delete(id);
      }
    }

    // Dispatch eligible fibers we don't already have a live worker for.
    const entries: DispatchEntry[] = [];
    for (const f of eligible) {
      const expectedSession = ralphSessionName(f.id);
      const existing = this.dispatched.get(f.id);
      const sessionLive = existing?.tmuxSession && ralphSessions.has(existing.tmuxSession);

      if (sessionLive) {
        entries.push(existing!);
        continue;
      }

      // Adopt an external ralph session if it already matches by name —
      // covers the case where the user (or a previous Shuttle process)
      // launched the same fiber manually.
      if (ralphSessions.has(expectedSession)) {
        const adopted: DispatchEntry = {
          fiberId: f.id,
          tmuxSession: expectedSession,
          state: 'running',
          startedAt: existing?.startedAt ?? Date.now(),
          reason: 'adopted existing tmux session',
        };
        this.dispatched.set(f.id, adopted);
        entries.push(adopted);
        continue;
      }

      // Spawn.
      try {
        const session = this.spawn(f.id);
        const entry: DispatchEntry = {
          fiberId: f.id,
          tmuxSession: session,
          state: 'running',
          startedAt: Date.now(),
        };
        this.dispatched.set(f.id, entry);
        entries.push(entry);
      } catch (err: unknown) {
        const msg = (err as { message?: string })?.message ?? String(err);
        entries.push({
          fiberId: f.id,
          state: 'idle',
          reason: `spawn failed: ${msg}`,
        });
        console.error(`[Shuttle] spawn failed for ${f.id}:`, msg);
      }
    }

    // Orphans: ralph-* sessions not tracked by us.
    const trackedSessions = new Set(
      Array.from(this.dispatched.values())
        .map(e => e.tmuxSession)
        .filter((s): s is string => !!s),
    );
    const orphans = Array.from(ralphSessions).filter(s => !trackedSessions.has(s));

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

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private spawn(fiberId: string): string {
    if (this.config.spawnRalph) {
      return this.config.spawnRalph(fiberId);
    }
    const script = this.config.ralphScript;
    if (!script || !existsSync(script)) {
      throw new Error(`ralph launcher not available at ${script}`);
    }
    // The launcher uses pwd as workdir for the agent. Use the felt host
    // so the agent lands in loom by default.
    const result = spawnSync(script, [fiberId], {
      cwd: this.config.feltHost,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(
        `ralph launcher failed (status ${result.status}): ${result.stderr || result.stdout}`,
      );
    }
    return ralphSessionName(fiberId);
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
