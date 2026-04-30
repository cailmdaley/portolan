/**
 * HttpApiGlobalSearch — cross-project fiber API (search + tree).
 *
 * Stages 1 + 2 of constitution-portolan-navigation-layer. The portolan map's
 * existing `/` palette searches *cities + workers*; this module adds two
 * more shapes over the same multi-host fiber pool:
 *
 *   - `/global-search?q=…` — Stage 2: extends the palette with a *fibers*
 *     section keyed off a free-text query.
 *   - `/global-fibers`     — Stage 1: the palette's empty-state body —
 *     a tree view grouped by city, used when the user opens `/` without
 *     typing a query.
 *
 * Architecturally a sibling of HttpApiKanban: same multi-host collection
 * (pinned local cities walked via FiberReader; remote origins read from
 * FiberTreeSnapshotStore), same realpath-and-id dedupe so a fiber visible
 * through multiple loom symlinks renders once, same cityId+projectSlug
 * resolution so the click-through pivots vellum to the project-scoped slug
 * instead of the loom-relative id (which vellum's collection would 404 on).
 *
 * Score model for search mirrors HttpApiTapestry.handleSearch (the per-city
 * /api/search endpoint vellum's side-strip uses): name 100, id 80, tags 40,
 * outcome 20, body 5. Substring contains-match, lower-cased; FTS5 is left
 * as a follow-up (the constitution explicitly defers semantic/embedding
 * search).
 */

import type { ServerResponse } from 'http';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getAllFibers, type Fiber } from './FiberReader.js';
import type { FiberTreeSnapshot } from './FiberTreeSnapshotStore.js';

// ============================================================================
// Wire types
// ============================================================================

export interface GlobalSearchHit {
  /** Fiber id (slug). For local fibers, project-relative when `cityId` set. */
  id: string;
  /**
   * Loom-relative id for fibers walked off a felt host whose layout includes
   * the symlinked project slice (e.g. `ai-futures/portolan/...`). When
   * `projectSlug` is set the click-through uses the projectSlug; this field
   * is for display + dedupe.
   */
  loomId?: string;
  name: string;
  status: string;
  kind: string;
  tags: string[];
  outcome?: string;
  /** First-line body excerpt around the matched needle (or lede if metadata-only match). */
  snippet?: string;
  /** Origin that contributed this fiber. `local` for filesystem-walk sources. */
  originId: string;
  /**
   * Pinned local city whose `.felt/` owns this fiber, when resolvable.
   * Drives click-through: vellum lands on this city, navigates to projectSlug.
   * Undefined for remote fibers (no realpath cross-machine) or for local
   * fibers whose path lies outside any pinned city.
   */
  cityId?: string;
  /** Slug relative to the owning city's `.felt/` (`vellum-reader/foo`, not `ai-futures/portolan/vellum-reader/foo`). */
  projectSlug?: string;
  /** Hostname for remote origins. Undefined for local. */
  hostname?: string;
  score: number;
}

export interface GlobalSearchResponse {
  hits: GlobalSearchHit[];
  generatedAt: number;
}

/**
 * One fiber row in the tree view (Stage 1). Slimmer than GlobalSearchHit —
 * no score, no snippet (the tree is browse-not-find), but carries `parentId`
 * + `hasChildren` so the frontend can render expand/collapse without
 * walking the full id table.
 */
export interface GlobalFiberNode {
  /** Click-through slug — projectSlug for local hits, loom id for unscoped. */
  id: string;
  loomId?: string;
  name: string;
  status: string;
  kind: string;
  tags: string[];
  /** First non-empty line of outcome (or body fallback), trimmed to ~120 chars. */
  outcome?: string;
  /**
   * Project-relative parent id derived from the displayed `id` (slash-prefix).
   * `null` for top-level fibers within the city. The frontend uses this to
   * fold children under their parent when rendering; descendant fibers whose
   * parent doesn't exist as a fiber file (intermediate dirs are bare scope
   * folders) still surface at top level — better to show than to drop.
   */
  parentId: string | null;
  /** True if any sibling fiber in this city group claims this node as parent. */
  hasChildren: boolean;
}

/** Fibers grouped by their owning city / origin, in tree-render order. */
export interface GlobalFiberCityGroup {
  /** Pinned local city id when resolvable; undefined for unmapped remote. */
  cityId?: string;
  /** `local` for filesystem-walk sources, `remote-<hostname>` for snapshots. */
  originId: string;
  /** Hostname for remote origins (display label). Undefined for local. */
  hostname?: string;
  /** Remote-origin snapshot status; local groups are always fresh. */
  isStale: boolean;
  /** ISO timestamp; populated for stale remote groups. */
  staleSince?: string;
  fibers: GlobalFiberNode[];
}

export interface GlobalFiberTreeResponse {
  cities: GlobalFiberCityGroup[];
  generatedAt: number;
}

// ============================================================================
// Options
// ============================================================================

interface HttpApiGlobalSearchOptions {
  /** Default felt host if `feltHosts` not provided. Defaults to ~/loom. */
  feltHost?: string;
  /**
   * Pinned local felt hosts. Mirrors HttpApiKanban — when populated, the
   * search aggregates across every host. Each host's fibers are realpath-
   * deduped against the others so a project's `.felt/` visible through
   * loom's symlink doesn't double-count.
   */
  feltHosts?: string[];
  /**
   * Pinned local cities (id + path). Used to resolve each hit's `cityId`
   * and project-relative `projectSlug` via realpath matching against the
   * fiber's md path. Without this the frontend can't pivot vellum into
   * the right collection.
   */
  cities?: Array<{ id: string; path: string }>;
  /** Remote-origin snapshot provider (Stage 3a wiring). */
  remoteSnapshotsProvider?: () => FiberTreeSnapshot[];
  /** Default cap for `?limit=`. Defaults to 30. */
  defaultLimit?: number;
  /** Hard cap for `?limit=`. Defaults to 200. */
  maxLimit?: number;
}

// ============================================================================
// Class
// ============================================================================

export class HttpApiGlobalSearch {
  private readonly feltHost: string;
  private readonly feltHosts: string[] | undefined;
  private readonly cities: Array<{ id: string; path: string }> | undefined;
  private readonly remoteSnapshotsProvider: (() => FiberTreeSnapshot[]) | undefined;
  private readonly defaultLimit: number;
  private readonly maxLimit: number;

  /** Lazy-init memo of city `.felt/` realpaths, sorted deepest-first. */
  private cityFeltRealpaths: Array<{ id: string; feltRealPath: string }> | null = null;

  constructor(opts: HttpApiGlobalSearchOptions = {}) {
    this.feltHost = opts.feltHost ?? join(homedir(), 'loom');
    this.feltHosts = opts.feltHosts && opts.feltHosts.length > 0 ? opts.feltHosts : undefined;
    this.cities = opts.cities && opts.cities.length > 0 ? opts.cities : undefined;
    this.remoteSnapshotsProvider = opts.remoteSnapshotsProvider;
    this.defaultLimit = opts.defaultLimit ?? 30;
    this.maxLimit = opts.maxLimit ?? 200;
  }

  /**
   * GET /global-search?q=… — fiber search across all configured hosts and
   * connected remote origins. Empty `q` returns an empty hits array (the
   * palette renders without firing this endpoint when input is empty,
   * but the server is defensive).
   */
  async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = (url.searchParams.get('q') ?? '').trim();
    const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(this.maxLimit, limitParam))
      : this.defaultLimit;

    if (!q) {
      this.json(res, 200, { hits: [], generatedAt: Date.now() });
      return;
    }

    try {
      const hits = await this.search(q, limit);
      this.json(res, 200, { hits, generatedAt: Date.now() });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[GlobalSearch] failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * Public for testing — does the multi-host collect + score + slice.
   * Empty query short-circuits to no hits; the empty string would otherwise
   * substring-match every fiber and the score model would degenerate.
   */
  async search(q: string, limit: number): Promise<GlobalSearchHit[]> {
    if (!q.trim()) return [];
    const merged = await this.collectFibers();
    if (merged.length === 0) return [];
    const needle = q.toLowerCase();

    const scored: Array<{ hit: GlobalSearchHit; score: number }> = [];
    for (const entry of merged) {
      const { fiber, originId, hostname, cityId, projectSlug, loomId } = entry;
      const score = scoreFiber(fiber, needle);
      if (score <= 0) continue;
      scored.push({
        hit: {
          id: projectSlug ?? fiber.id,
          loomId,
          name: fiber.name || fiber.id,
          status: fiber.status || 'open',
          kind: fiber.kind || 'task',
          tags: fiber.tags ?? [],
          outcome: fiber.outcome,
          snippet: makeSnippet(fiber, needle),
          originId,
          cityId,
          projectSlug,
          hostname,
          score,
        },
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.hit);
  }

  /**
   * GET /global-fibers — tree view of every fiber across all configured
   * hosts and connected remote origins, grouped by owning city. Powers the
   * `/` palette's empty-state body (Stage 1 of constitution-portolan-
   * navigation-layer). No query parameter; the response is the full tree.
   */
  async handleTree(_url: URL, res: ServerResponse): Promise<void> {
    try {
      const cities = await this.tree();
      this.json(res, 200, { cities, generatedAt: Date.now() });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[GlobalSearch] tree failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * Public for testing — collect every fiber, group by city/origin, compute
   * parentId+hasChildren so the frontend can render expand/collapse without
   * walking the full id table itself.
   *
   * Group ordering: local first, then alphabetical by cityId/hostname so
   * a stable disconnect/reconnect cycle doesn't reshuffle the tree.
   */
  async tree(): Promise<GlobalFiberCityGroup[]> {
    const merged = await this.collectFibers();
    if (merged.length === 0) return [];

    const groups = new Map<string, GlobalFiberCityGroup>();
    const remoteSnapshotByOrigin = new Map<string, FiberTreeSnapshot>();
    if (this.remoteSnapshotsProvider) {
      for (const snap of this.remoteSnapshotsProvider()) {
        remoteSnapshotByOrigin.set(snap.originId, snap);
      }
    }

    for (const entry of merged) {
      // Group key: cityId for resolved-local, originId otherwise. Local
      // fibers without a cityId (an unpinned felt host) collapse into a
      // single "unscoped local" bucket so the user sees them at all.
      const isLocal = entry.originId === 'local';
      const key = isLocal && entry.cityId
        ? `local::${entry.cityId}`
        : isLocal
        ? 'local::?'
        : entry.originId;

      let group = groups.get(key);
      if (!group) {
        const snap = !isLocal ? remoteSnapshotByOrigin.get(entry.originId) : undefined;
        group = {
          cityId: entry.cityId,
          originId: entry.originId,
          hostname: entry.hostname,
          isStale: snap?.status === 'stale',
          staleSince: snap?.staleSince,
          fibers: [],
        };
        groups.set(key, group);
      }

      const id = entry.projectSlug ?? entry.fiber.id;
      group.fibers.push({
        id,
        loomId: entry.loomId,
        name: entry.fiber.name || id,
        status: entry.fiber.status || 'open',
        kind: entry.fiber.kind || 'task',
        tags: entry.fiber.tags ?? [],
        outcome: makeLede(entry.fiber),
        parentId: parentIdOf(id),
        hasChildren: false, // patched in second pass
      });
    }

    // Second pass: hasChildren + sort. Sort alphabetically by id so the
    // tree reads like a directory listing — parents adjacent to their
    // children, siblings stable across calls.
    for (const group of groups.values()) {
      const idsInGroup = new Set(group.fibers.map((f) => f.id));
      const claimedAsParent = new Set<string>();
      for (const f of group.fibers) {
        if (f.parentId && idsInGroup.has(f.parentId)) claimedAsParent.add(f.parentId);
      }
      for (const f of group.fibers) {
        f.hasChildren = claimedAsParent.has(f.id);
      }
      group.fibers.sort((a, b) => a.id.localeCompare(b.id));
    }

    return [...groups.values()].sort((a, b) => {
      if (a.originId === 'local' && b.originId !== 'local') return -1;
      if (b.originId === 'local' && a.originId !== 'local') return 1;
      const aKey = a.cityId ?? a.hostname ?? a.originId;
      const bKey = b.cityId ?? b.hostname ?? b.originId;
      return aKey.localeCompare(bKey);
    });
  }

  /**
   * Walk every configured host + fold in remote snapshots. Same dedupe
   * shape as HttpApiKanban.collectFibers — local entries dedupe by
   * realpath of the md file (so loom-symlinked projects appear once);
   * remote entries dedupe by fiber id against the local set (a remote
   * mirror of a local fiber yields to local).
   */
  private async collectFibers(): Promise<MergedEntry[]> {
    const seen = new Map<string, MergedEntry>();
    const seenIds = new Set<string>();

    for (const host of this.resolveHosts()) {
      if (!existsSync(join(host, '.felt'))) continue;
      let fibers: Fiber[];
      try {
        fibers = await getAllFibers(host);
      } catch (err) {
        console.error(`[GlobalSearch] getAllFibers failed for host ${host}:`, err);
        continue;
      }
      for (const fiber of fibers) {
        const path = this.fiberPath(host, fiber);
        let canonical: string;
        try {
          canonical = realpathSync(path);
        } catch {
          continue;
        }
        if (seen.has(canonical)) continue;
        const basename = fiber.id.split('/').pop() ?? fiber.id;
        const resolved = this.resolveCityForCanonicalPath(canonical, basename);
        seen.set(canonical, {
          fiber,
          originId: 'local',
          cityId: resolved?.cityId,
          projectSlug: resolved?.projectSlug,
          loomId: fiber.id,
        });
        seenIds.add(fiber.id);
      }
    }

    if (this.remoteSnapshotsProvider) {
      for (const snap of this.remoteSnapshotsProvider()) {
        const hostname = snap.originId.replace(/^remote-/, '');
        for (const fiber of snap.fibers) {
          if (seenIds.has(fiber.id)) continue;
          const key = `${snap.originId}::${fiber.id}`;
          if (seen.has(key)) continue;
          seen.set(key, {
            fiber,
            originId: snap.originId,
            hostname,
          });
          seenIds.add(fiber.id);
        }
      }
    }

    return [...seen.values()];
  }

  private resolveHosts(): string[] {
    return this.feltHosts ?? [this.feltHost];
  }

  private fiberPath(host: string, f: Fiber): string {
    const segments = f.id.split('/');
    const basename = segments[segments.length - 1];
    return f.isRoot
      ? join(host, '.felt', `${basename}.md`)
      : join(host, '.felt', f.id, `${basename}.md`);
  }

  /**
   * Match a fiber's canonical (realpath) md path against pinned cities.
   * Mirrors HttpApiKanban.resolveCityForCanonicalPath — keep in sync if that
   * resolver evolves. Deepest realpath wins so portolan's `.felt/`
   * (the physical location) beats loom's `.felt/ai-futures/portolan/`
   * (the symlink mount).
   */
  private resolveCityForCanonicalPath(
    canonicalPath: string,
    basename: string,
  ): { cityId: string; projectSlug: string } | null {
    for (const { id, feltRealPath } of this.getCityFeltRealpaths()) {
      const prefix = `${feltRealPath}/`;
      if (!canonicalPath.startsWith(prefix)) continue;
      const rel = canonicalPath.slice(prefix.length);
      const fileSuffix = `${basename}.md`;
      if (rel === fileSuffix) {
        return { cityId: id, projectSlug: basename };
      }
      const dirSuffix = `/${fileSuffix}`;
      if (rel.endsWith(dirSuffix)) {
        return { cityId: id, projectSlug: rel.slice(0, -dirSuffix.length) };
      }
    }
    return null;
  }

  private getCityFeltRealpaths(): Array<{ id: string; feltRealPath: string }> {
    if (this.cityFeltRealpaths !== null) return this.cityFeltRealpaths;
    const out: Array<{ id: string; feltRealPath: string }> = [];
    for (const c of this.cities ?? []) {
      try {
        out.push({ id: c.id, feltRealPath: realpathSync(join(c.path, '.felt')) });
      } catch {
        // missing .felt — silently skip; can't own any resolution
      }
    }
    out.sort((a, b) => b.feltRealPath.length - a.feltRealPath.length);
    this.cityFeltRealpaths = out;
    return out;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
  }
}

// ============================================================================
// Internals
// ============================================================================

interface MergedEntry {
  fiber: Fiber;
  originId: string;
  cityId?: string;
  projectSlug?: string;
  hostname?: string;
  /** Loom-relative id (display fallback when projectSlug isn't resolvable). */
  loomId?: string;
}

/**
 * Score a fiber against a lower-cased needle. Mirrors
 * HttpApiTapestry.handleSearch — name hits dominate body hits so the
 * dropdown ordering matches what the user expects ("constitution shuttle"
 * surfaces fibers literally named that, not bodies that mention both).
 */
function scoreFiber(fiber: Fiber, needle: string): number {
  const name = (fiber.name || fiber.id).toLowerCase();
  const id = fiber.id.toLowerCase();
  const outcome = (fiber.outcome ?? '').toLowerCase();
  const body = (fiber.body ?? '').toLowerCase();
  const tags = (fiber.tags ?? []).join(' ').toLowerCase();

  let score = 0;
  if (name.includes(needle)) score += 100;
  if (id.includes(needle)) score += 80;
  if (tags.includes(needle)) score += 40;
  if (outcome.includes(needle)) score += 20;
  if (body.includes(needle)) score += 5;
  return score;
}

/**
 * Snippet: a window around the first body match, or the body's lede
 * for tag-only / metadata-only hits so the result row isn't blank.
 */
function makeSnippet(fiber: Fiber, needle: string): string | undefined {
  if (!fiber.body) return fiber.outcome?.split('\n').find((line) => line.trim())?.slice(0, 120);
  const bodyLower = fiber.body.toLowerCase();
  const idx = bodyLower.indexOf(needle);
  if (idx >= 0) {
    const start = Math.max(0, idx - 40);
    const end = Math.min(fiber.body.length, idx + needle.length + 80);
    return (
      (start > 0 ? '…' : '') +
      fiber.body.slice(start, end).replace(/\s+/g, ' ').trim() +
      (end < fiber.body.length ? '…' : '')
    );
  }
  return fiber.body.split('\n').find((line) => line.trim())?.slice(0, 120);
}

/**
 * Lede for the tree view: first non-empty line of `outcome`, falling back to
 * `body`. Trimmed to 120 chars so the row stays one-line. Used by `tree()`
 * only — the search side prefers the needle-windowed snippet.
 */
function makeLede(fiber: Fiber): string | undefined {
  const sources = [fiber.outcome, fiber.body];
  for (const src of sources) {
    if (!src) continue;
    const firstLine = src.split('\n').find((line) => line.trim());
    if (firstLine) return firstLine.trim().slice(0, 120);
  }
  return undefined;
}

/**
 * Project-relative parent id: everything before the last `/`. `null` for
 * top-level fibers within their city group. Computed off the displayed id
 * (projectSlug for resolved-local, loom id otherwise) so the frontend's
 * fold/expand reads off the same string the user clicks.
 */
function parentIdOf(id: string): string | null {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(0, slash) : null;
}
