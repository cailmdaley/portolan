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
 *   - Agent connects → ships `fiber_tree_dump` (one .md file per fiber).
 *     `upsertFullDump` replaces the prior snapshot wholesale and flips
 *     status to 'fresh'.
 *   - File events on the agent side → debounced+batched
 *     `fiber_tree_delta` (per-file upsert/delete). `applyDelta` mutates
 *     the existing snapshot in place.
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

import { parseFiber, type Fiber } from './FiberReader.js';

// ============================================================================
// Wire types
// ============================================================================

/** A single .md file shipped from agent to server, path relative to .felt/. */
export interface FiberTreeFile {
  /** Path relative to the agent's feltHost `.felt/` dir. e.g. `cmbx/cmbx.md`. */
  path: string;
  content: string;
}

/** A delta op shipped after the initial dump. */
export interface FiberTreeDelta {
  path: string;
  op: 'upsert' | 'delete';
  /** Required for `upsert`; ignored for `delete`. */
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

  /**
   * Replace the snapshot for an origin wholesale. Files whose path doesn't
   * resolve to a fiber id (non-container .md files, junk) are silently
   * skipped — the agent ships every .md under .felt/ and the server filters.
   */
  upsertFullDump(originId: string, feltHost: string, files: FiberTreeFile[]): void {
    const byId = new Map<string, Fiber>();
    for (const file of files) {
      const fiber = parseFileToFiber(file.path, file.content);
      if (fiber) byId.set(fiber.id, fiber);
    }
    this.snapshots.set(originId, {
      originId,
      feltHost,
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
  applyDelta(originId: string, deltas: FiberTreeDelta[]): void {
    const snap = this.snapshots.get(originId);
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
      } else if (delta.op === 'upsert' && delta.content !== undefined) {
        const fiber = parseFiber(idInfo.id, delta.content);
        fiber.isRoot = idInfo.isRoot;
        fiber.parentId = idInfo.parentId;
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
    const snap = this.snapshots.get(originId);
    if (snap) {
      snap.status = 'stale';
      snap.staleSince = sinceIso;
    }
  }

  /** Mark an origin's snapshot fresh again — for an explicit reconnect ack. */
  markFresh(originId: string): void {
    const snap = this.snapshots.get(originId);
    if (snap) {
      snap.status = 'fresh';
      snap.staleSince = undefined;
    }
  }

  /** Drop an origin's snapshot entirely — useful for tests, not used in v1 prod. */
  clear(originId: string): void {
    this.snapshots.delete(originId);
  }

  getSnapshot(originId: string): FiberTreeSnapshot | null {
    return this.snapshots.get(originId) ?? null;
  }

  /** All known snapshots. Order is insertion-order (Map semantics). */
  getAllSnapshots(): FiberTreeSnapshot[] {
    return [...this.snapshots.values()];
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

function parseFileToFiber(path: string, content: string): Fiber | null {
  const idInfo = idFromPath(path);
  if (!idInfo) return null;
  const fiber = parseFiber(idInfo.id, content);
  fiber.isRoot = idInfo.isRoot;
  fiber.parentId = idInfo.parentId;
  return fiber;
}
