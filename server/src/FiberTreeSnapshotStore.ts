/**
 * FiberTreeSnapshotStore — per-origin fiber-tree snapshots pushed by agents.
 *
 * Stage 3a of [[ai-futures/portolan/vellum-reader/constitution-vellum-kanban]].
 *
 * Local origins still walk the filesystem on demand via FiberReader; this
 * store covers *remote* origins only — their `.felt/` trees live on a
 * different machine, so the agent ships fiber-tree state over the WebSocket.
 *
 * Lifecycle:
 *   - Agent connects → ships `fiber_tree_dump` (one felt-JSON payload per
 *     fiber, plus the `.felt/`-relative path it came from). `upsertFullDump`
 *     replaces the prior snapshot wholesale and flips status to 'fresh'.
 *   - File events on the agent side → debounced+batched
 *     `fiber_tree_delta` (per-file upsert/delete carrying felt JSON on
 *     upsert). `applyDelta` mutates the existing snapshot in place.
 *   - Agent disconnects → `markStale` flips status; the snapshot is
 *     *kept* (last-known-good) so the kanban can still render the cards
 *     with a "waiting on <hostname>" badge until reconnect (the badge
 *     ships in Stage 3b).
 *   - Agent reconnects → fresh dump, `upsertFullDump` again — no
 *     reconciliation needed because the agent is the sole writer to its
 *     host's `.felt/` tree.
 *
 * The store handles only the wire data → in-memory `Fiber[]` translation.
 * It does *not* know about cities, kanban scoping, or HTTP — those are
 * HttpApiKanban's job. See [[finding-restaged-implementation-plan]] §3a.
 */

import { parse as parseYaml } from 'yaml';
import { mapFeltJsonToFiber, type Fiber } from './FiberReader.js';

// ============================================================================
// Wire types
// ============================================================================

/** One felt JSON payload shipped from agent to server, keyed by .felt path. */
export interface FiberTreeFile {
  /** Path relative to the agent's feltHost `.felt/` dir. e.g. `cmbx/cmbx.md`. */
  path: string;
  /** Parsed `felt show -j` / `felt ls -j --body` payload for this fiber. */
  fiber?: unknown;
  /** Legacy fallback for pre-Phase-1 tests / agents; active code paths use `fiber`. */
  content?: string;
}

/** A delta op shipped after the initial dump. */
export interface FiberTreeDelta {
  path: string;
  op: 'upsert' | 'delete';
  /** Required for `upsert`; ignored for `delete`. */
  fiber?: unknown;
  /** Legacy fallback for pre-Phase-1 tests / agents; active code paths use `fiber`. */
  content?: string;
}

// ============================================================================
// Snapshot
// ============================================================================

export interface FiberTreeSnapshot {
  originId: string;
  /**
   * The agent's feltHost path on the *remote* machine — informational, used
   * for debugging and (eventually) per-city scoping. The local server can't
   * stat this path; treat it as opaque.
   */
  feltHost: string;
  /**
   * Canonical fiber list. Always matches `byId.values()` — kept eagerly so
   * callers iterating large snapshots don't pay a Map.values() each time.
   */
  fibers: Fiber[];
  /** id → Fiber, for fast lookup and dependsOn resolution. */
  byId: Map<string, Fiber>;
  /** Wall-clock timestamp of the last full dump (for debugging / staleness UI). */
  lastFullDump: Date;
  status: 'fresh' | 'stale';
  /** ISO timestamp; populated when status flips to 'stale'. */
  staleSince?: string;
}

// ============================================================================
// Store
// ============================================================================

export class FiberTreeSnapshotStore {
  private snapshots = new Map<string, FiberTreeSnapshot>();

  private key(originId: string, feltHost: string): string {
    return `${originId}\u0000${normalizeHost(feltHost)}`;
  }

  /**
   * Replace the snapshot for an origin wholesale. Files whose path doesn't
   * resolve to a fiber id (non-container .md files, junk) are silently
   * skipped — the agent ships felt JSON for every candidate under .felt/
   * and the server filters by container shape.
   */
  upsertFullDump(originId: string, feltHost: string, files: FiberTreeFile[]): void {
    const normalizedHost = normalizeHost(feltHost);
    const byId = new Map<string, Fiber>();
    for (const file of files) {
      const fiber = coerceWireFiber(file.path, file.fiber ?? file.content);
      if (fiber) byId.set(fiber.id, fiber);
    }
    this.snapshots.set(this.key(originId, normalizedHost), {
      originId,
      feltHost: normalizedHost,
      fibers: [...byId.values()],
      byId,
      lastFullDump: new Date(),
      status: 'fresh',
    });
  }

  /**
   * Apply a batch of per-file deltas to the existing snapshot. Drops the
   * batch (with a warning) if no snapshot exists yet — deltas before the
   * initial dump are a protocol violation we don't try to repair.
   */
  applyDelta(originId: string, deltas: FiberTreeDelta[], feltHost?: string): void {
    const snap = this.resolveSnapshot(originId, feltHost);
    if (!snap) {
      console.warn(
        `[FiberTreeSnapshotStore] delta arrived for originId=${originId} ` +
          `before initial dump; dropping ${deltas.length} ops`,
      );
      return;
    }
    let mutated = false;
    for (const delta of deltas) {
      const idInfo = idFromPath(delta.path);
      if (!idInfo) continue; // not a container fiber file
      if (delta.op === 'delete') {
        if (snap.byId.delete(idInfo.id)) mutated = true;
      } else if (delta.op === 'upsert') {
        const fiber = coerceWireFiber(delta.path, delta.fiber ?? delta.content);
        if (!fiber) continue;
        snap.byId.set(idInfo.id, fiber);
        mutated = true;
      }
    }
    if (mutated) {
      snap.fibers = [...snap.byId.values()];
    }
    // Receiving a delta means the agent is still alive and shipping; flip
    // back to fresh in case a heartbeat-based stale check raced ahead.
    snap.status = 'fresh';
    snap.staleSince = undefined;
  }

  /** Mark an origin's snapshot stale (kept, but flagged). For Stage 3b UI. */
  markStale(originId: string, sinceIso: string): void {
    for (const snap of this.snapshotsForOrigin(originId)) {
      snap.status = 'stale';
      snap.staleSince = sinceIso;
    }
  }

  /** Mark an origin's snapshot fresh again — for an explicit reconnect ack. */
  markFresh(originId: string): void {
    for (const snap of this.snapshotsForOrigin(originId)) {
      snap.status = 'fresh';
      snap.staleSince = undefined;
    }
  }

  /** Drop an origin's snapshot entirely — useful for tests, not used in v1 prod. */
  clear(originId: string): void {
    for (const key of [...this.snapshots.keys()]) {
      if (key === originId || key.startsWith(`${originId}\u0000`)) {
        this.snapshots.delete(key);
      }
    }
  }

  getSnapshot(originId: string, feltHost?: string): FiberTreeSnapshot | null {
    return this.resolveSnapshot(originId, feltHost);
  }

  /** All known snapshots. Order is insertion-order (Map semantics). */
  getAllSnapshots(): FiberTreeSnapshot[] {
    return [...this.snapshots.values()];
  }

  private snapshotsForOrigin(originId: string): FiberTreeSnapshot[] {
    return [...this.snapshots.values()].filter(snap => snap.originId === originId);
  }

  private resolveSnapshot(originId: string, feltHost?: string): FiberTreeSnapshot | null {
    if (feltHost !== undefined) {
      return this.snapshots.get(this.key(originId, feltHost)) ?? null;
    }
    const exactLegacy = this.snapshots.get(originId);
    if (exactLegacy) return exactLegacy;
    return this.snapshotsForOrigin(originId)[0] ?? null;
  }

  /**
   * Stage 7 — return the originIds of currently-stale snapshots that
   * contain `fiberId`. Empty when no stale origin owns the fiber.
   *
   * Shuttle's dispatcher consults this to suspend dispatch into fibers
   * whose canonical writer (a remote agent) has gone silent. The check
   * is conservative: if *any* stale snapshot lists the fiber, dispatch
   * is suspended — the agent might be racing with a worker on the same
   * file, and we'd rather pause than risk a write conflict. When the
   * agent reconnects, snapshots flip back to fresh (via `applyDelta` or
   * `markFresh`) and dispatch resumes on the next tick.
   *
   * Local-only fibers (never appearing in any remote snapshot) always
   * return []. Fibers visible in BOTH a fresh and a stale snapshot still
   * trip the gate — being authoritatively-edited-elsewhere matters more
   * than a parallel fresh source.
   */
  getStaleOriginsForFiber(fiberId: string): string[] {
    const stale: string[] = [];
    for (const snap of this.snapshots.values()) {
      if (snap.status !== 'stale') continue;
      if (snap.byId.has(fiberId)) stale.push(snap.originId);
    }
    return stale;
  }

  /**
   * Return the originIds of *every* snapshot — fresh or stale — that
   * contains `fiberId`. Empty when no remote snapshot owns the fiber
   * (i.e. it's local-only).
   *
   * Constitution `shuttle-remote-dispatch`: the server's Shuttle uses
   * this to identify fibers whose dispatch should be deferred to a
   * remote agent. A fresh remote owner means an alive agent will run
   * the worker on its own machine; a stale remote owner means the
   * Stage-7 gate has already suspended dispatch. Either way, the
   * server should not race with the agent over the same fiber file.
   *
   * The shape is symmetric to `getStaleOriginsForFiber` so callers can
   * pick the predicate that matches their gate semantics.
   */
  getOriginsForFiber(fiberId: string): string[] {
    const origins: string[] = [];
    for (const snap of this.snapshots.values()) {
      if (snap.byId.has(fiberId)) origins.push(snap.originId);
    }
    return origins;
  }
}

// ============================================================================
// Path helpers
// ============================================================================

/**
 * Translate a `.felt/`-relative file path to a fiber id, if and only if the
 * path corresponds to a container .md file. Mirrors FiberReader's walk:
 *
 *   - `<slug>.md`                       → entry-point fiber, id = `<slug>`
 *   - `<dir>/<dir>.md`                  → container fiber,    id = `<dir>`
 *   - `<a>/<b>/<b>.md`                  → nested container,  id = `<a>/<b>`
 *   - `<a>/<b>/sibling.md`              → not a fiber file, returns null
 *
 * Returns null for non-container .md files so the caller skips them
 * silently — same shape as FiberReader.walkFibers, which only emits
 * fibers for the matching dir/dir.md pattern.
 */
export function idFromPath(filePath: string): {
  id: string;
  isRoot: boolean;
  parentId: string | null;
} | null {
  if (!filePath.endsWith('.md')) return null;
  const cleaned = filePath.replace(/^\.?\/?/, '');
  const noExt = cleaned.slice(0, -3);
  const parts = noExt.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    // Entry-point fiber at .felt/<slug>.md
    return { id: parts[0], isRoot: true, parentId: null };
  }
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (last !== secondLast) {
    // <...>/<dir>/<not-dir>.md — not a fiber container.
    return null;
  }
  const idParts = parts.slice(0, -1);
  const id = idParts.join('/');
  const parentId = idParts.length > 1 ? idParts.slice(0, -1).join('/') : null;
  return { id, isRoot: false, parentId };
}

function normalizeHost(feltHost: string): string {
  return feltHost.replace(/\/+$/, '');
}

function coerceWireFiber(path: string, raw: unknown): Fiber | null {
  const idInfo = idFromPath(path);
  if (!idInfo) return null;

  const normalized =
    typeof raw === 'string'
      ? legacyContentToFeltJson(raw)
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
  if (!normalized) return null;

  const seeded = {
    ...normalized,
    id: idInfo.id,
    entry_point: idInfo.isRoot,
  };
  const fiber = mapFeltJsonToFiber(seeded);
  if (!fiber) return null;
  fiber.isRoot = idInfo.isRoot;
  fiber.parentId = idInfo.parentId;
  return fiber;
}

function legacyContentToFeltJson(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatter = match ? match[1] : '';
  const body = match ? content.slice(match[0].length) : content;

  try {
    const parsed = parseYaml(frontmatter);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fm = { ...(parsed as Record<string, unknown>) };
    if ('created-at' in fm) fm.created_at = fm['created-at'];
    if ('closed-at' in fm) fm.closed_at = fm['closed-at'];
    if ('depends-on' in fm) fm.depends_on = fm['depends-on'];
    return { ...fm, body };
  } catch {
    return null;
  }
}
