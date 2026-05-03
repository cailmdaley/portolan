/**
 * HttpApiKanban — global kanban view of shuttle-managed fibers.
 *
 * Reads fibers from a felt host (defaults to ~/loom — the loom monorepo,
 * which symlinks every project's `.felt/`), filters to shuttle-managed fibers
 * (those with a `shuttle:` frontmatter block, or legacy `constitution`-tagged
 * fibers for backward-compatibility during migration), and groups by lifecycle
 * stage. `tempered` is a tristate verdict field — absent (no verdict yet),
 * `true` (accepted), `false` (composted: mooted / superseded / did not survive
 * review). The classifier reads all three:
 *
 *   - in-flight       : status != closed (open / active / dispatchable)
 *   - awaiting-review : status == closed && tempered absent (agent-paused handoff)
 *   - tempered        : status == closed && tempered === true (human-accepted)
 *   - composted       : status == closed && tempered === false (human-rejected)
 *
 * The write side rescues `false` for actual composting: every non-verdict
 * transition (drafts, inFlight, awaitingReview) *clears* `tempered` rather
 * than stamping `false`. Only `tempered` and `composted` targets write the
 * field. See `applyTargetToFrontmatter` for the line-based writer and
 * [[ai-futures/shuttle/constitution-kanban-compost]] for the rationale.
 *
 * The "awaiting-review" column is the human-tempering action queue and the
 * primary reason this view exists. See:
 * .felt/ai-futures/portolan/shuttle/constitution-shuttle.
 *
 * Card source filter: post-migration, a fiber must have a `shuttle:` block.
 * Pre-migration (or for legacy fibers), the `constitution` tag is the fallback.
 * After running `shuttle migrate`, every eligible fiber has both, so the union
 * produces the same set as the old tag-only filter — byte-identical eligibility.
 *
 * v0 is read-only — clicking a card opens the fiber's md in vellum on the
 * frontend; tempering/un-tempering happens via CLI for now. Will grow to
 * include Shuttle dispatch state and an inline temper button.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { URL } from 'url';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getAllFibers, type Fiber } from './FiberReader.js';
import type { FiberTreeSnapshot } from './FiberTreeSnapshotStore.js';
import { listShuttleSessions, shuttleSessionName } from './Shuttle.js';

export interface KanbanCard {
  id: string;
  name: string;
  /** Absolute filesystem path to the fiber's md (for open-in-vellum). */
  path: string;
  /**
   * Origin that contributed this fiber — `local` for filesystem-walk
   * sources, `remote-<hostname>` for fibers sourced from an agent's
   * fiber-tree snapshot. Drives remote-origin badging and (Stage 3b)
   * the "waiting on <hostname>" stale state.
   */
  originId: string;
  status: string;
  outcome?: string;
  tags?: string[];
  createdAt: string;
  closedAt?: string;
  tempered?: boolean;
  dependsOn?: string[];
  /** True if every dependsOn fiber resolves to tempered:true. */
  dependsOnSatisfied: boolean;
  /**
   * tmux session name of a running Shuttle worker for this fiber, when one
   * is detected at request time. Drives the queued vs active split: a card
   * with a runningWorker is shown in the Active column regardless of status,
   * a card without one and `status==open` is Queued.
   */
  runningWorker?: string;
  /**
   * The pinned local city whose `.felt/` physically owns this fiber, when
   * resolvable. Computed by realpath-matching the fiber's md against each
   * city's `<path>/.felt` realpath; the deepest match wins so a city like
   * `portolan` (whose `.felt/` is symlinked into `loom/.felt/ai-futures/portolan/`)
   * resolves to itself rather than to loom.
   *
   * Drives the click-to-open flow on the frontend: when the kanban is global
   * (no city scope), the card's `id` is loom-relative and meaningless to the
   * vellum collection; the frontend reads `cityId` + `projectSlug` to pivot
   * vellum to the owning city and navigate to the project-relative slug.
   * Undefined for fibers whose canonical path doesn't fall under any pinned
   * local city (e.g. remote-origin snapshots, or a felt host that isn't
   * pinned as a city).
   */
  cityId?: string;
  /**
   * Slug relative to the owning city's `.felt/` root (e.g.
   * `vellum-reader/constitution-vellum-kanban`). Pairs with `cityId`. The
   * vellum collection's astra graph is keyed by these project-relative
   * slugs, so this is what the frontend hands to `navigate()`.
   */
  projectSlug?: string;
}

export interface KanbanColumns {
  /** Constitution-tagged AND draft-tagged. Brainstorming, hidden from Shuttle. */
  drafts: KanbanCard[];
  /** Constitution-tagged, NOT draft, status != closed. Queue + active are one bucket. */
  inFlight: KanbanCard[];
  /** Constitution-tagged, status=closed && tempered absent (the human-tempering queue). */
  awaitingReview: KanbanCard[];
  /** Constitution-tagged, status=closed && tempered:true (recent N). */
  tempered: KanbanCard[];
  /**
   * Constitution-tagged, status=closed && tempered:false — composted. The
   * human verdict for "tried it / considered it / no longer pursuing." See
   * [[ai-futures/shuttle/constitution-kanban-compost]].
   */
  composted: KanbanCard[];
}

/**
 * Per-origin freshness signal — drives the "waiting on <hostname>" badge
 * on remote cards and Shuttle dispatch suspension. Stage 3a populates the
 * map server-side; Stage 3b will consume it in the kanban frontend.
 *
 * Local origin is always 'fresh' (the local filesystem is the live source).
 * Remote origins are 'fresh' while their portolan-agent is connected and
 * pushing; flip to 'stale' on agent disconnect with `staleSince` set to
 * the disconnection timestamp.
 */
export interface KanbanOriginStaleness {
  status: 'fresh' | 'stale';
  /** Hostname for human-readable badging (e.g. "waiting on cineca"). */
  hostname?: string;
  /** ISO timestamp; only set when status='stale'. */
  staleSince?: string;
}

export interface KanbanResponse {
  feltHost: string;
  columns: KanbanColumns;
  totals: {
    drafts: number;
    inFlight: number;
    awaitingReview: number;
    tempered: number;
    composted: number;
  };
  /** Total tempered count *before* slicing — UI shows recent N but we surface the full count. */
  temperedTotal: number;
  /**
   * Per-origin freshness, keyed by `originId`. Always includes `local`
   * (always fresh) plus an entry for every remote origin that has a
   * snapshot in the store, regardless of whether it currently
   * contributes any cards in the response. The frontend uses this to
   * render the "waiting on <hostname>" badge per card and (Stage 3b)
   * to disable drag targets for stale-origin cards.
   */
  staleness: Record<string, KanbanOriginStaleness>;
  /**
   * Sorted unique tag set across **all** fibers in the resolved hosts,
   * not just constitution-tagged ones. Powers the stash-button form's
   * tag autocomplete (constitution-stash-button) without forcing a
   * separate `/tags` round-trip — the frontend already polls /kanban on
   * mount, and the cost of collecting tags from the same `collectFibers`
   * walk is trivial. Excludes empty strings; multi-comma-split tags are
   * already normalized at FiberReader's parse step.
   */
  tagIndex: string[];
  generatedAt: number;
}

interface HttpApiKanbanOptions {
  /** Felt host (parent of `.felt/`). Defaults to ~/loom. */
  feltHost?: string;
  /**
   * Optional multi-host aggregation. When provided non-empty, the kanban
   * collects constitution fibers from each host (calling `getAllFibers`
   * per host), and dedupes by `realpath` of each fiber's md file —
   * ensuring that fibers shared across cities (e.g. a project whose
   * `.felt/` is symlinked into loom's monorepo) appear once. First-seen
   * wins, in host iteration order.
   *
   * The kanban's *global* default uses this to span every pinned local
   * city — fibers that don't live under loom (e.g. a wedding project on
   * iCloud with its own private `.felt/`) become first-class. The
   * `?cityId=`-scoped path leaves this undefined and uses `feltHost`
   * (Stage 1 behavior, single-host).
   *
   * `applyTransition` searches across the same host list to locate the
   * fiber's file before writing.
   */
  feltHosts?: string[];
  /**
   * Pinned local cities, used to resolve each card's `cityId` + `projectSlug`
   * via realpath matching. Without this, the frontend's click-to-open path
   * gets a loom-relative fiber id (e.g. `ai-futures/portolan/vellum-reader/X`)
   * which doesn't match any slug in the project-scoped vellum collection.
   *
   * The match is deepest-prefix-wins on `<city.path>/.felt` realpath: a
   * fiber under a project city whose `.felt/` is symlinked into loom resolves
   * to the project, not to loom — so the frontend knows which city to pivot
   * to and which project-relative slug to navigate to.
   */
  cities?: Array<{ id: string; path: string }>;
  /**
   * Provider for remote-origin fiber-tree snapshots — Stage 3a of the
   * vellum-kanban constitution. Returns the per-origin snapshots that
   * have been pushed by connected portolan-agents. Called per request
   * so newly-arrived dumps and deltas surface without restart.
   *
   * The kanban folds these into the merged set after the local-host
   * walks: remote entries dedupe by id (no realpath cross-machine), and
   * a remote fiber whose id collides with a local entry yields to the
   * local copy — local-mirror-of-remote (e.g. an rsynced loom on the
   * laptop and the live one on cineca) renders as one card sourced from
   * local. Pure remote-only-no-mirror fibers appear once via the agent.
   */
  remoteSnapshotsProvider?: () => FiberTreeSnapshot[];
  /**
   * Stage 4 — executor for remote-origin transitions. When a card's origin
   * isn't `local`, `applyTransition` ships the mutation through this
   * callback instead of writing the file directly. The callback owns the
   * agent round-trip (correlation-ID send + reply wait) and the
   * snapshot-store delta apply, so by the time it resolves the snapshot
   * for `originId` already reflects the new state and the kanban can
   * re-read the refreshed fiber via `remoteSnapshotsProvider`.
   *
   * `path` is relative to the agent's `feltHost/.felt/` (e.g.
   * `cmbx/cmbx.md`); the agent reconstructs the absolute path. `nowIso`
   * is the timestamp to stamp into `closed-at` when the target asks for
   * one — passed through so the server's clock wins in case of skew.
   *
   * If undefined, remote-origin transitions throw the Stage-4 boundary
   * error (preserves Stage 3a behaviour for tests that don't wire an
   * executor).
   */
  remoteTransitionExecutor?: (args: {
    originId: string;
    fiberId: string;
    path: string;
    target: KanbanTarget;
    nowIso: string;
  }) => Promise<void>;
  /** Max tempered cards to return. Defaults to 30. */
  temperedLimit?: number;
  /** Override clock for transitions (testing). */
  now?: () => Date;
  /**
   * Test seam: list of currently-running shuttle session names
   * (`shuttle-<fiber-id>`). Defaults to a real `tmux ls` probe via
   * Shuttle.listShuttleSessions. Empty list = no workers known to be running.
   */
  listSessions?: () => string[];
  /**
   * Short-lived cache for the collected fiber pool, in milliseconds.
   * Defaults to 0 for direct unit-test use; HttpApi sets a small TTL so
   * repeated Kanban reads don't re-walk every felt host.
   */
  cacheTtlMs?: number;
}

/**
 * Where a transition can land a card.
 *
 *   drafts          → adds the `draft` tag, clears `tempered`, parks in drafts column
 *   inFlight        → removes `draft` tag, status=active, clears `tempered`, clears closed-at
 *   awaitingReview  → status=closed, clears `tempered` (agent-paused handoff)
 *   tempered        → status=closed, tempered=true  (human-accepted)
 *   composted       → status=closed, tempered=false (human-rejected: mooted, superseded)
 *
 * `tempered` is tristate. Only the verdict targets (`tempered`, `composted`)
 * write the field; every other target *clears* it so the absent state means
 * "no verdict" and `false` is reserved for actual composting. See
 * [[ai-futures/shuttle/constitution-kanban-compost]].
 *
 * Legacy aliases kept for v0/v1 clients: `queued`/`active` both fold into
 * `inFlight` (the queued vs active split was decoration, not workflow).
 */
export type KanbanTarget =
  | 'drafts'
  | 'inFlight'
  | 'awaitingReview'
  | 'tempered'
  | 'composted'
  // Legacy aliases (queued/active mapped to inFlight)
  | 'queued'
  | 'active';

type KanbanFiberEntry = {
  fiber: Fiber;
  host: string;
  originId: string;
  canonicalPath?: string;
};

interface KanbanFiberPool {
  merged: KanbanFiberEntry[];
  byId: Map<string, Fiber>;
}

/** What POST /kanban/transition expects in the body. */
export interface KanbanTransitionRequest {
  fiberId: string;
  target: KanbanTarget;
}

export class HttpApiKanban {
  private readonly feltHost: string;
  private readonly feltHosts: string[] | undefined;
  private readonly cities: Array<{ id: string; path: string }> | undefined;
  private readonly remoteSnapshotsProvider: (() => FiberTreeSnapshot[]) | undefined;
  private readonly remoteTransitionExecutor:
    | HttpApiKanbanOptions['remoteTransitionExecutor']
    | undefined;
  private readonly temperedLimit: number;
  private readonly now: () => Date;
  private readonly listSessions: () => string[];
  private readonly cacheTtlMs: number;

  /**
   * Per-instance memo: realpath of each pinned city's `.felt` directory,
   * sorted deepest-first so prefix matches pick the most-specific city
   * (e.g. portolan's `.felt/` wins over loom's `.felt/`, which sym-links
   * into it). Computed lazily on first lookup; null until populated.
   */
  private cityFeltRealpaths: Array<{ id: string; feltRealPath: string }> | null = null;
  private fiberPoolCache: {
    expiresAt: number;
    result: KanbanFiberPool;
  } | null = null;
  private fiberPoolInFlight: Promise<KanbanFiberPool> | null = null;

  constructor(opts: HttpApiKanbanOptions = {}) {
    this.feltHost = opts.feltHost ?? join(homedir(), 'loom');
    this.feltHosts = opts.feltHosts && opts.feltHosts.length > 0 ? opts.feltHosts : undefined;
    this.cities = opts.cities && opts.cities.length > 0 ? opts.cities : undefined;
    this.remoteSnapshotsProvider = opts.remoteSnapshotsProvider;
    this.remoteTransitionExecutor = opts.remoteTransitionExecutor;
    this.temperedLimit = opts.temperedLimit ?? 30;
    this.now = opts.now ?? (() => new Date());
    this.listSessions = opts.listSessions ?? listShuttleSessions;
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
  }

  /**
   * Lazy-init the city `.felt/` realpath table. Cities whose `.felt/`
   * doesn't exist or can't be statted are silently skipped — they
   * contribute no fibers, so they can't own any card resolution.
   *
   * Sorted deepest-first: for a fiber whose canonical path lies under both
   * `loom/.felt/ai-futures/portolan/` (via symlink) and
   * `Documents/projects/portolan/.felt/` (the physical location), the
   * portolan entry wins because its realpath is the actual deeper one
   * the symlink resolves to.
   */
  private getCityFeltRealpaths(): Array<{ id: string; feltRealPath: string }> {
    if (this.cityFeltRealpaths !== null) return this.cityFeltRealpaths;
    const out: Array<{ id: string; feltRealPath: string }> = [];
    for (const c of this.cities ?? []) {
      const feltPath = join(c.path, '.felt');
      try {
        out.push({ id: c.id, feltRealPath: realpathSync(feltPath) });
      } catch {
        // city's .felt is missing or unreadable — skip; it can't own any
        // card resolution either way.
      }
    }
    out.sort((a, b) => b.feltRealPath.length - a.feltRealPath.length);
    this.cityFeltRealpaths = out;
    return out;
  }

  /**
   * Match a fiber's canonical (realpath) md path against pinned cities and
   * return the owning `{ cityId, projectSlug }`. Returns null when no city
   * owns the path (e.g. unpinned felt host, no cities configured, or
   * canonical path doesn't end in the expected `<basename>.md`).
   *
   * `basename` is the fiber's last id segment — used to peel the trailing
   * file from the relative path to recover the project-relative slug
   * (`vellum-reader/constitution-vellum-kanban`, not the longer
   * `vellum-reader/constitution-vellum-kanban/constitution-vellum-kanban.md`).
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
        // Root fiber: <feltRealPath>/<basename>.md → slug is the basename.
        return { cityId: id, projectSlug: basename };
      }
      const dirSuffix = `/${fileSuffix}`;
      if (rel.endsWith(dirSuffix)) {
        return { cityId: id, projectSlug: rel.slice(0, -dirSuffix.length) };
      }
      // Prefix matched but layout is unexpected (e.g. an alternative basename);
      // bail without claiming this card. Fall through to the next city.
    }
    return null;
  }

  /** Hosts to walk for /kanban reads + /kanban/transition writes. */
  private resolveHosts(): string[] {
    return this.feltHosts ?? [this.feltHost];
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
   * Walk every configured host and return constitution-tag-filtering's input:
   * a flat list of `{fiber, host, originId}` entries deduped:
   *
   *   - Local-host walks dedupe by `realpath` of the fiber's md file —
   *     the kanban's loom-symlink scenario where a project's `.felt/`
   *     appears via multiple mount points still renders the fiber once.
   *     First-seen wins, in host iteration order.
   *   - Remote snapshots (Stage 3a, pushed by portolan-agent) fold in
   *     after the local walk. They dedupe against the local set by id —
   *     no realpath cross-machine, but a remote fiber whose id matches
   *     a local entry yields to local (the local copy is canonical when
   *     both exist; pure remote-only fibers don't collide). Within the
   *     remote set itself, first-snapshot wins on id collision (rare —
   *     same fiber id existing on two different remote hosts would
   *     mean the user manually synced; not a worried-about case).
   *
   * The `host` field threads through `toCard` so the per-card `path`
   * always resolves against the contributing host. For local that's the
   * filesystem path used to read the file; for remote that's the
   * snapshot's `feltHost` (a path on the *remote* machine — the local
   * server can't stat it, but it's correct as an identifier and as
   * what shows up in clickthrough URLs once Stage 5/6 wire vellum to
   * remote origins).
   *
   * `byId` (used for dependsOn satisfaction) is built off the merged
   * set, so cross-host dependency references resolve correctly when
   * the dependee is reachable through *any* configured host or remote
   * snapshot.
   */
  private async collectFibers(): Promise<KanbanFiberPool> {
    const now = Date.now();
    if (
      this.cacheTtlMs > 0 &&
      this.fiberPoolCache !== null &&
      this.fiberPoolCache.expiresAt > now
    ) {
      return this.fiberPoolCache.result;
    }
    if (this.fiberPoolInFlight !== null) return this.fiberPoolInFlight;

    const pending = this.collectFibersFresh();
    this.fiberPoolInFlight = pending;
    try {
      const result = await pending;
      if (this.cacheTtlMs > 0) {
        this.fiberPoolCache = {
          result,
          expiresAt: Date.now() + this.cacheTtlMs,
        };
      }
      return result;
    } finally {
      if (this.fiberPoolInFlight === pending) this.fiberPoolInFlight = null;
    }
  }

  private async collectFibersFresh(): Promise<KanbanFiberPool> {
    const seen = new Map<string, KanbanFiberEntry>();
    const seenIds = new Set<string>();

    const hostResults = await Promise.all(
      this.resolveHosts().map(async (host) => {
        if (!existsSync(join(host, '.felt'))) return { host, fibers: [] as Fiber[] };
        try {
          return { host, fibers: await getAllFibers(host) };
        } catch (err) {
          console.error(`[Kanban] getAllFibers failed for host ${host}:`, err);
          return { host, fibers: [] as Fiber[] };
        }
      }),
    );

    for (const { host, fibers } of hostResults) {
      for (const f of fibers) {
        const path = this.fiberPath(host, f);
        let canonical: string;
        try {
          canonical = realpathSync(path);
        } catch {
          continue; // fiber file moved out from under us; skip rather than crash
        }
        if (!seen.has(canonical)) {
          seen.set(canonical, { fiber: f, host, originId: 'local', canonicalPath: canonical });
          seenIds.add(f.id);
        }
      }
    }
    // Remote snapshots: id-deduped against the local set we just built,
    // and against each other. Use a synthetic key (`<originId>:<id>`)
    // for the seen-map so they don't collide with the realpath keys.
    // Remote entries have no `canonicalPath` — we can't realpath a remote
    // file path locally, and city resolution doesn't apply across machines.
    if (this.remoteSnapshotsProvider) {
      for (const snapshot of this.remoteSnapshotsProvider()) {
        for (const f of snapshot.fibers) {
          if (seenIds.has(f.id)) continue;
          const key = `${snapshot.originId}::${f.id}`;
          if (!seen.has(key)) {
            seen.set(key, { fiber: f, host: snapshot.feltHost, originId: snapshot.originId });
            seenIds.add(f.id);
          }
        }
      }
    }
    const merged = [...seen.values()];
    const byId = new Map(merged.map(({ fiber }) => [fiber.id, fiber]));
    return { merged, byId };
  }

  private clearFiberPoolCache(): void {
    this.fiberPoolCache = null;
    this.fiberPoolInFlight = null;
  }

  /** GET /kanban → KanbanResponse. */
  async handleKanban(_url: URL, res: ServerResponse): Promise<void> {
    try {
      const { merged, byId } = await this.collectFibers();
      if (merged.length === 0) {
        this.json(res, 200, this.emptyResponse());
        return;
      }

      // Tag autocomplete index: union across the full unfiltered merged set
      // so the stash-button form sees every tag the user has ever applied,
      // not just constitution-related ones. Sorted lex for stable ordering
      // in the autocomplete dropdown.
      const tagIndex = collectTagIndex(merged);

      // Shuttle-managed fibers: those with a shuttle: block (post-migration)
      // OR a constitution tag (pre-migration legacy fallback). After running
      // `shuttle migrate`, every eligible fiber has both, so the union is
      // identical to the old tag-only filter.
      const constitutional = merged.filter(({ fiber }) =>
        fiber.hasShuttleBlock === true || fiber.tags?.includes('constitution'),
      );

      // Probe live shuttle workers — drives the running-worker indicator on
      // in-flight cards, and bumps them to the top of the column.
      const liveSessions = new Set(this.listSessions());

      const drafts: KanbanCard[] = [];
      const inFlight: KanbanCard[] = [];
      const awaitingReview: KanbanCard[] = [];
      const tempered: KanbanCard[] = [];
      const composted: KanbanCard[] = [];

      for (const { fiber: f, host, originId, canonicalPath } of constitutional) {
        const card = this.toCard(f, host, originId, byId, liveSessions, canonicalPath);
        const isDraft = f.tags?.includes('draft') ?? false;
        if (f.status !== 'closed') {
          if (isDraft) drafts.push(card);
          else inFlight.push(card);
        } else if (f.tempered === true) {
          tempered.push(card);
        } else if (f.tempered === false) {
          composted.push(card);
        } else {
          awaitingReview.push(card);
        }
      }

      // Sort:
      //   drafts          : most-recently-created first (these are works-in-progress)
      //   inFlight        : running workers / status:active first, then by createdAt desc
      //   awaitingReview  : most-recently-closed first
      //   tempered        : most-recently-closed first
      //   composted       : most-recently-closed first (the discarded, in reverse chrono)
      drafts.sort(byCreatedAtDesc);
      inFlight.sort((a, b) => {
        const aActive = a.runningWorker || a.status === 'active' ? 0 : 1;
        const bActive = b.runningWorker || b.status === 'active' ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return byCreatedAtDesc(a, b);
      });
      awaitingReview.sort(byClosedAtDesc);
      tempered.sort(byClosedAtDesc);
      composted.sort(byClosedAtDesc);

      const temperedTotal = tempered.length;
      const temperedSliced = tempered.slice(0, this.temperedLimit);

      this.json(res, 200, {
        feltHost: this.feltHost,
        columns: {
          drafts,
          inFlight,
          awaitingReview,
          tempered: temperedSliced,
          composted,
        },
        totals: {
          drafts: drafts.length,
          inFlight: inFlight.length,
          awaitingReview: awaitingReview.length,
          tempered: temperedSliced.length,
          composted: composted.length,
        },
        temperedTotal,
        staleness: this.buildStaleness(),
        tagIndex,
        generatedAt: Date.now(),
      } satisfies KanbanResponse);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[Kanban] failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * POST /kanban/transition → move a fiber between columns.
   *
   * Body: { fiberId, target: 'inFlight' | 'awaitingReview' | 'tempered' }.
   *
   * Maps target → frontmatter mutation:
   *   inFlight        : status=active, tempered=false, clear closed-at
   *   awaitingReview  : status=closed, tempered=false, set closed-at if missing
   *   tempered        : status=closed, tempered=true,  set closed-at if missing
   *
   * The agent's "I'm done" handoff is `awaitingReview` (status flip), per the
   * Path B protocol in constitution-shuttle. Setting `tempered: true` is the
   * human-only acceptance signal. This endpoint enforces neither — the human
   * is driving every transition here, so any direction is allowed (including
   * in-flight → tempered to skip review for trusted work).
   *
   * Frontmatter editing is line-based to preserve unrelated formatting (block
   * scalars, comments, ordering). The frontmatter must parse as YAML for the
   * sanity check, but the YAML parser's output is *not* re-stringified back
   * into the file — only the targeted lines change.
   */
  async handleTransition(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: KanbanTransitionRequest;
    try {
      body = await readJsonBody<KanbanTransitionRequest>(req);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 400, { error: `bad request body: ${msg}` });
      return;
    }
    if (!body || typeof body.fiberId !== 'string' || typeof body.target !== 'string') {
      this.json(res, 400, { error: 'fiberId and target are required' });
      return;
    }
    const validTargets: KanbanTarget[] = [
      'drafts',
      'inFlight',
      'queued',
      'active',
      'awaitingReview',
      'tempered',
      'composted',
    ];
    if (!validTargets.includes(body.target)) {
      this.json(res, 400, { error: `unknown target: ${body.target}` });
      return;
    }

    try {
      const updated = await this.applyTransition(body.fiberId, body.target);
      this.json(res, 200, { ok: true, card: updated });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[Kanban] transition failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * Resolve a fiber by id, mutate its frontmatter on disk, and return the
   * refreshed card. Throws if the fiber is missing or not constitution-tagged
   * (the kanban refuses to mutate fibers it wouldn't display, as a guardrail).
   *
   * Multi-host correctness: must use the same realpath dedupe as
   * `collectFibers`. Fiber ids can collide across hosts — e.g.
   * `vellum-reader/map` exists *both* in lightcone-myst-coherence's
   * `.felt/` (the version the kanban displays) *and* under
   * `loom/.felt/ai-futures/portolan/vellum-reader/map/` (an unrelated
   * stale closed fiber, surfaced as `vellum-reader/map` to the
   * portolan-as-city view via that city's `.felt/` symlink).
   *
   * Iterating `resolveHosts()` in order and matching first-by-id picks the
   * portolan-side stale fiber and writes the `draft` tag there — silently
   * mutating a different file than the one the kanban rendered. The read
   * side already deduplicates by `realpathSync(fiberPath(host, f))`, so we
   * route the transition through the same merged set: the host that
   * contributed this fiber's *displayed* card is the host we write to.
   */
  async applyTransition(fiberId: string, target: KanbanTarget): Promise<KanbanCard> {
    const { merged } = await this.collectFibers();
    const entry = merged.find(({ fiber }) => fiber.id === fiberId);
    if (!entry) throw new Error(`fiber not found: ${fiberId}`);
    const { fiber, host, originId } = entry;
    if (!(fiber.hasShuttleBlock === true || fiber.tags?.includes('constitution'))) {
      throw new Error(
        `kanban only mutates shuttle-managed fibers; ${fiberId} has no shuttle: block` +
          (fiber.tags?.length ? ` and no constitution tag (tags: ${fiber.tags.join(', ')})` : ''),
      );
    }
    const nowIso = this.now().toISOString();

    if (originId !== 'local') {
      // Stage 4 — route through the agent over the correlation-ID layer.
      // The executor owns the round-trip and the snapshot-store delta apply
      // so by the time it resolves, the remote snapshot for this origin
      // already reflects the new state and the refreshed card we return
      // matches what the next /kanban GET will show.
      if (!this.remoteTransitionExecutor) {
        throw new Error(
          `remote-origin transitions require remoteTransitionExecutor wiring ` +
            `(fiber ${fiberId} is on origin '${originId}')`,
        );
      }
      const relPath = relativeFeltPath(fiber);
      await this.remoteTransitionExecutor({
        originId,
        fiberId,
        path: relPath,
        target,
        nowIso,
      });
      this.clearFiberPoolCache();
      // Re-read the snapshot via the provider — the executor has applied the
      // delta, so byId for this origin carries the post-write fiber.
      const refreshedById = new Map<string, Fiber>();
      if (this.remoteSnapshotsProvider) {
        for (const snap of this.remoteSnapshotsProvider()) {
          if (snap.originId !== originId) continue;
          for (const f of snap.fibers) refreshedById.set(f.id, f);
        }
      }
      const refreshed = refreshedById.get(fiberId);
      if (!refreshed) {
        throw new Error(
          `remote fiber disappeared from snapshot after transition: ${fiberId}`,
        );
      }
      return this.toCard(refreshed, host, originId, refreshedById);
    }

    const path = this.fiberPath(host, fiber);
    if (!existsSync(path)) {
      throw new Error(`fiber file missing on disk: ${path}`);
    }

    const raw = readFileSync(path, 'utf-8');
    const updated = applyTargetToFrontmatter(raw, target, nowIso);
    if (updated !== raw) {
      writeFileSync(path, updated, 'utf-8');
    }
    this.clearFiberPoolCache();

    // Re-read this host so the returned card reflects the new state.
    const after = await getAllFibers(host);
    const refreshedById = new Map(after.map(f => [f.id, f]));
    const refreshed = refreshedById.get(fiberId);
    if (!refreshed) throw new Error(`fiber disappeared after write: ${fiberId}`);
    // Recompute the canonical path so the refreshed card carries the same
    // cityId/projectSlug fields that /kanban GET emits — without it, an
    // immediate optimistic-rerender after a transition would lose the
    // click-to-open routing for the moved card.
    let canonicalAfter: string | undefined;
    try {
      canonicalAfter = realpathSync(this.fiberPath(host, refreshed));
    } catch {
      canonicalAfter = undefined;
    }
    return this.toCard(refreshed, host, originId, refreshedById, undefined, canonicalAfter);
  }

  /**
   * POST /kanban/tags — replace the full tag set on a fiber, preserving all
   * other frontmatter fields. Returns the refreshed KanbanCard so the
   * frontend can update in place.
   *
   * Body: { fiberId, tags: string[] }
   *
   * Route resolution is the same as applyTransition (same merge lookup,
   * same remote-origin routing) — the feature respects city scope / owning
   * origin per the constitution acceptance criteria.
   */
  async handleTags(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { fiberId: string; tags: string[] };
    try {
      body = await readJsonBody<{ fiberId: string; tags: string[] }>(req);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 400, { error: `bad request body: ${msg}` });
      return;
    }
    if (!body || typeof body.fiberId !== 'string' || !Array.isArray(body.tags)) {
      this.json(res, 400, { error: 'fiberId and tags[] are required' });
      return;
    }

    try {
      const updated = await this.applyTags(body.fiberId, body.tags);
      this.json(res, 200, { ok: true, card: updated });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[Kanban] tags edit failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * Resolve a fiber by id, replace its tags in the frontmatter, and return
   * the refreshed card. Follows the same multi-host / remote-origin routing
   * as applyTransition:
   *
   *   - Local origin: read the file, apply tag replacement via
   *     mutateTagsInPlace({ replace }), write back, clear cache, re-read.
   *   - Remote origin: route through remoteTransitionExecutor if wired
   *     (the executor\'s `target` is unused for tags but the path goes
   *     through the same correlation-ID layer), or throw a clear error.
   */
  async applyTags(fiberId: string, tags: string[]): Promise<KanbanCard> {
    const { merged } = await this.collectFibers();
    const entry = merged.find(({ fiber }) => fiber.id === fiberId);
    if (!entry) throw new Error(`fiber not found: ${fiberId}`);
    const { fiber, host, originId, canonicalPath } = entry;

    // Normalize: trim each tag, remove empties, deduplicate while preserving
    // insertion order. The 'constitution' tag is always kept — removing it
    // from a kanban-visible card would make the fiber disappear from the
    // board on the next refresh, which is user-hostile.
    const seen = new Set<string>();
    const normalized: string[] = ['constitution'];
    for (const t of tags) {
      const trimmed = t.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      normalized.push(trimmed);
    }

    if (originId !== 'local') {
      // Remote origin: try to route through the executor. The executor\'s
      // `target` field is unused for tags but the path goes through the
      // same correlation-ID layer so the remote agent can apply the change.
      if (!this.remoteTransitionExecutor) {
        throw new Error(
          `remote-origin tag edits require remoteTransitionExecutor wiring ` +
            `(fiber ${fiberId} is on origin '${originId}')`,
        );
      }
      const relPath = relativeFeltPath(fiber);
      // Ship the full tag set as a JSON payload on the `target` field;
      // the remote executor interprets it as a tag-replace command.
      await this.remoteTransitionExecutor({
        originId,
        fiberId,
        path: relPath,
        target: `__tags__${JSON.stringify(normalized)}` as KanbanTarget,
        nowIso: '',
      });
      this.clearFiberPoolCache();
      const refreshedById = new Map<string, Fiber>();
      if (this.remoteSnapshotsProvider) {
        for (const snap of this.remoteSnapshotsProvider()) {
          if (snap.originId !== originId) continue;
          for (const f of snap.fibers) refreshedById.set(f.id, f);
        }
      }
      const refreshed = refreshedById.get(fiberId);
      if (!refreshed) throw new Error(`remote fiber disappeared: ${fiberId}`);
      return this.toCard(refreshed, host, originId, refreshedById);
    }

    // Local origin: read file, mutate tags, write back.
    const path = this.fiberPath(host, fiber);
    if (!existsSync(path)) throw new Error(`fiber file missing: ${path}`);

    const raw = readFileSync(path, 'utf-8');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!fmMatch) throw new Error('file has no YAML frontmatter; refusing to mutate');

    const fmBlock = fmMatch[1];
    const after = raw.slice(fmMatch[0].length);
    const fmLines = fmBlock.split(/\r?\n/);
    mutateTagsInPlace(fmLines, { replace: normalized });
    const updated = `---\n${fmLines.join('\n')}\n---\n${after}`;

    if (updated !== raw) {
      writeFileSync(path, updated, 'utf-8');
    }
    this.clearFiberPoolCache();

    // Re-read this host so the returned card reflects the new tags.
    const afterFibers = await getAllFibers(host);
    const refreshedById = new Map(afterFibers.map(f => [f.id, f]));
    const refreshed = refreshedById.get(fiberId);
    if (!refreshed) throw new Error(`fiber disappeared after write: ${fiberId}`);
    let canonicalAfter: string | undefined;
    try {
      canonicalAfter = realpathSync(this.fiberPath(host, refreshed));
    } catch {
      canonicalAfter = undefined;
    }
    return this.toCard(refreshed, host, originId, refreshedById, undefined, canonicalAfter);
  }

  // ---------------------------------------------------------------------------

  private toCard(
    f: Fiber,
    host: string,
    originId: string,
    byId: Map<string, Fiber>,
    liveSessions: Set<string> = new Set(),
    canonicalPath?: string,
  ): KanbanCard {
    const dependsOn = f.dependsOn ?? [];
    const dependsOnSatisfied =
      dependsOn.length === 0 ||
      dependsOn.every(d => byId.get(d)?.tempered === true);

    // The fiber's md file lives under the *contributing* host: a fiber that
    // appeared via loom carries a loom path; a fiber that lives in a
    // standalone-city `.felt/` (no loom symlink) carries that city's path.
    // Pre-multi-host code computed this off `this.feltHost` and silently
    // returned a wrong path for the latter case. Remote-origin fibers
    // carry their feltHost path on the *remote* machine (the local server
    // can't stat it; it's an identifier, not a clickable file path here —
    // remote clickthrough wires up via the agent in Stages 5/6).
    const path = this.fiberPath(host, f);

    const runningWorker = resolveRunningWorker(f.id, liveSessions);

    // Resolve which pinned local city physically owns this fiber so the
    // frontend can pivot vellum to that city and navigate to the project-
    // relative slug. Loom-relative ids (`ai-futures/portolan/vellum-reader/X`)
    // don't match anything in a project-scoped fiber graph; the kanban-side
    // canonical-path realpath gets us back to the project-rooted view.
    let cityId: string | undefined;
    let projectSlug: string | undefined;
    if (canonicalPath !== undefined) {
      const segments = f.id.split('/');
      const basename = segments[segments.length - 1];
      const owner = this.resolveCityForCanonicalPath(canonicalPath, basename);
      if (owner !== null) {
        cityId = owner.cityId;
        projectSlug = owner.projectSlug;
      }
    }

    return {
      id: f.id,
      name: f.name,
      path,
      originId,
      status: f.status,
      outcome: f.outcome,
      tags: f.tags,
      createdAt: f.createdAt,
      closedAt: f.closedAt,
      tempered: f.tempered,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      dependsOnSatisfied,
      runningWorker,
      cityId,
      projectSlug,
    };
  }

  private emptyResponse(): KanbanResponse {
    return {
      feltHost: this.feltHost,
      columns: { drafts: [], inFlight: [], awaitingReview: [], tempered: [], composted: [] },
      totals: { drafts: 0, inFlight: 0, awaitingReview: 0, tempered: 0, composted: 0 },
      temperedTotal: 0,
      staleness: this.buildStaleness(),
      tagIndex: [],
      generatedAt: Date.now(),
    };
  }

  /**
   * Build the per-origin freshness map from the snapshot provider.
   * Local is always present and always 'fresh'. Each remote origin with
   * a snapshot contributes an entry — fresh while the agent is connected
   * (status='fresh' set by upsertFullDump / applyDelta) and stale after
   * disconnect (status='stale', staleSince set by markStale, snapshot
   * preserved as last-known-good).
   *
   * Stage 3b's frontend reads this to render "waiting on <hostname>"
   * badges and disable drag for stale-origin cards.
   */
  private buildStaleness(): Record<string, KanbanOriginStaleness> {
    const out: Record<string, KanbanOriginStaleness> = {
      local: { status: 'fresh' },
    };
    if (!this.remoteSnapshotsProvider) return out;
    for (const snap of this.remoteSnapshotsProvider()) {
      const hostname = snap.originId.replace(/^remote-/, '');
      out[snap.originId] = {
        status: snap.status,
        hostname,
        staleSince: snap.staleSince,
      };
    }
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

// ── Tag index ─────────────────────────────────────────────────────────────
// Sorted unique tag set across the merged fiber list, used by the stash-
// button form's autocomplete (constitution-stash-button). Empty/whitespace
// tags drop on the floor; FiberReader has already split comma-bundled tags.

function collectTagIndex(merged: Array<{ fiber: Fiber }>): string[] {
  const seen = new Set<string>();
  for (const { fiber } of merged) {
    if (!Array.isArray(fiber.tags)) continue;
    for (const t of fiber.tags) {
      if (typeof t !== 'string') continue;
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      seen.add(trimmed);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ── Sort helpers ─────────────────────────────────────────────────────────────
// String compare on ISO-8601 timestamps is order-correct.

function byCreatedAtDesc(a: KanbanCard, b: KanbanCard): number {
  return (b.createdAt || '').localeCompare(a.createdAt || '');
}

function byClosedAtDesc(a: KanbanCard, b: KanbanCard): number {
  // Fall back to createdAt for fibers missing closedAt.
  const aT = a.closedAt || a.createdAt || '';
  const bT = b.closedAt || b.createdAt || '';
  return bT.localeCompare(aT);
}

function resolveRunningWorker(fiberId: string, liveSessions: Set<string>): string | undefined {
  const exact = shuttleSessionName(fiberId);
  if (liveSessions.has(exact)) return exact;

  // Scoped kanban cards are project-relative (`constitution-x`) while the
  // daemon may have dispatched from the global loom host
  // (`ai-futures/shuttle/constitution-x`). Preserve exact-match priority,
  // then allow a slash-boundary suffix match so city-scoped views show the
  // same worker indicator as the global view.
  const suffix = `/${fiberId}`;
  return [...liveSessions].sort().find(session => session.endsWith(suffix));
}

/**
 * Reconstruct a fiber's path relative to its `.felt/` root, mirroring the
 * agent-side and FiberReader walks:
 *   isRoot=true        → `<id>.md`
 *   isRoot=false       → `<id>/<basename>.md` where basename is the last
 *                        path segment of the id
 *
 * Stage 4 ships this to the agent in `kanban-transition` so the agent can
 * resolve `feltHost/.felt/<relPath>` without re-deriving the convention.
 * This is the inverse of `idFromPath` in FiberTreeSnapshotStore.
 */
function relativeFeltPath(fiber: Fiber): string {
  const segments = fiber.id.split('/');
  const basename = segments[segments.length - 1];
  return fiber.isRoot ? `${basename}.md` : `${fiber.id}/${basename}.md`;
}

// ── JSON body reader ─────────────────────────────────────────────────────────

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) throw new Error('empty body');
  return JSON.parse(raw) as T;
}

// ── Frontmatter line editor ──────────────────────────────────────────────────

/**
 * Mutate the YAML frontmatter section of a fiber's md content to match the
 * target column. Returns the new full file contents.
 *
 * Line-based: only the `status:`, `tempered:`, and `closed-at:` lines are
 * touched. Everything else (other fields, comments, body, block scalars) is
 * preserved byte-identical. New fields are inserted at the end of the
 * frontmatter block, preserving its trailing `---` delimiter.
 */
export function applyTargetToFrontmatter(
  raw: string,
  target: KanbanTarget,
  nowIso: string,
): string {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    // No frontmatter to mutate — refuse, the file isn't a fiber by our
    // contract. Caller should not have routed us here.
    throw new Error('file has no YAML frontmatter; refusing to mutate');
  }

  const fmBlock = fmMatch[1];
  const after = raw.slice(fmMatch[0].length);
  const fmLines = fmBlock.split(/\r?\n/);

  // Compute desired values per target.
  //   drafts          → keep status (or default active), add 'draft' tag, clear tempered, clear closed-at
  //   inFlight        → status=active, remove 'draft' tag, clear tempered, clear closed-at
  //   queued/active   → legacy aliases for inFlight (queued vs active was decoration)
  //   awaitingReview  → status=closed, clear tempered (agent-paused handoff)
  //   tempered        → status=closed, tempered=true  (human-accepted)
  //   composted       → status=closed, tempered=false (human-rejected verdict)
  //
  // `tempered === null` here means "remove the field on write." Only the
  // verdict targets (tempered, composted) write a boolean; every other
  // target clears it. This rescues `tempered: false` for actual composting
  // — see [[ai-futures/shuttle/constitution-kanban-compost]].
  let status: string | null;  // null = leave untouched
  let tempered: boolean | null;  // null = clear the field
  let closedAtAction: 'set-if-missing' | 'clear';
  let tagsToAdd: string[] = [];
  let tagsToRemove: string[] = [];
  switch (target) {
    case 'drafts':
      // Don't force a status when filing as draft — preserve whatever shape
      // the fiber already has (often `open` from felt add). The draft tag is
      // what matters for kanban classification.
      status = null;
      tempered = null;
      closedAtAction = 'clear';
      tagsToAdd = ['draft'];
      break;
    case 'inFlight':
    case 'queued':
    case 'active':
      status = 'active';
      tempered = null;
      closedAtAction = 'clear';
      tagsToRemove = ['draft'];
      break;
    case 'awaitingReview':
      status = 'closed';
      tempered = null;
      closedAtAction = 'set-if-missing';
      break;
    case 'tempered':
      status = 'closed';
      tempered = true;
      closedAtAction = 'set-if-missing';
      break;
    case 'composted':
      status = 'closed';
      tempered = false;
      closedAtAction = 'set-if-missing';
      break;
  }

  // Top-level scalar field replacement: matches "<key>: <value>" at indent 0.
  // Doesn't touch lines that are part of a list, indented child, or block
  // scalar — those have non-zero indent or start with "-".
  const setOrInsertScalar = (key: string, value: string): void => {
    const re = new RegExp(`^${escapeRegex(key)}:[\\t ]*.*$`);
    let replaced = false;
    for (let i = 0; i < fmLines.length; i++) {
      if (re.test(fmLines[i])) {
        fmLines[i] = `${key}: ${value}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) fmLines.push(`${key}: ${value}`);
  };

  const clearScalar = (key: string): void => {
    const re = new RegExp(`^${escapeRegex(key)}:[\\t ]*.*$`);
    for (let i = fmLines.length - 1; i >= 0; i--) {
      if (re.test(fmLines[i])) fmLines.splice(i, 1);
    }
  };

  if (status !== null) setOrInsertScalar('status', status);
  if (tempered === null) {
    clearScalar('tempered');
  } else {
    setOrInsertScalar('tempered', tempered ? 'true' : 'false');
  }

  if (closedAtAction === 'clear') {
    clearScalar('closed-at');
  } else {
    // Set only if no existing value. We probe with a regex against the lines
    // (post status/tempered edits, but those don't share a key with closed-at).
    const closedRe = /^closed-at:[\t ]*(.+)$/;
    const hasClosedAt = fmLines.some(l => closedRe.test(l));
    if (!hasClosedAt) {
      fmLines.push(`closed-at: ${nowIso}`);
    }
  }

  // Tag mutations come last so the surrounding scalar edits don't disturb the
  // tags block's line indices.
  mutateTagsInPlace(fmLines, { add: tagsToAdd, remove: tagsToRemove });

  const newFm = fmLines.join('\n');
  return `---\n${newFm}\n---\n${after}`;
}

/**
 * In-place mutation of the `tags:` block within a frontmatter line array.
 *
 * Recognized shapes:
 *   tags:
 *     - foo
 *     - bar
 *
 *   tags: [foo, bar]
 *
 * Both are normalized to the indented-list form on write. If `tags:` doesn't
 * exist, a fresh block is appended at the end of the frontmatter.
 *
 * Safe for round-trips: if no add/remove changes membership, the existing
 * lines are left untouched (no reformatting drift).
 */
export function mutateTagsInPlace(
  fmLines: string[],
  opts: { add?: string[]; remove?: string[]; replace?: string[] },
): void {
  // Full replace mode: set the tag list to exactly `replace`, normalized.
  // Ignored when `add` or `remove` are set so diff-style callers still work.
  if (opts.replace !== undefined && opts.add === undefined && opts.remove === undefined) {
    const newTags = [...new Set(opts.replace.map(t => t.trim()).filter(Boolean))];

    // Find and replace the existing tags block.
    for (let i = 0; i < fmLines.length; i++) {
      if (/^tags:\s*$/.test(fmLines[i])) {
        // Block-list form — collect existing tags and see if unchanged.
        const existing: string[] = [];
        let j = i + 1;
        while (j < fmLines.length && /^[ \t]+- /.test(fmLines[j])) {
          const m = fmLines[j].match(/^[ \t]+- (.+)$/);
          if (m) existing.push(m[1].trim().replace(/^["']|["']$/g, '').trim());
          j++;
        }
        if (newTags.length === existing.length && newTags.every((t, ix) => t === existing[ix])) return;
        fmLines.splice(i + 1, j - i - 1, ...newTags.map(t => `  - ${t}`));
        return;
      }
      // Inline form: `tags: [a, b]`
      const inline = fmLines[i].match(/^tags:\s*\[(.*)\]\s*$/);
      if (inline) {
        const existing = inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
        if (newTags.length === existing.length && newTags.every((t, ix) => t === existing[ix])) return;
        fmLines.splice(i, 1, 'tags:', ...newTags.map(t => `  - ${t}`));
        return;
      }
    }
    // No tags block at all — append fresh.
    fmLines.push('tags:', ...newTags.map(t => `  - ${t}`));
    return;
  }

  const add = opts.add ?? [];
  const remove = opts.remove ?? [];
  if (add.length === 0 && remove.length === 0) return;

  // Locate the existing tags block.
  let blockStart = -1;
  let blockEnd = -1;
  let existing: string[] = [];

  for (let i = 0; i < fmLines.length; i++) {
    // Block-list form: `tags:` on its own line, then indented `- item` lines.
    if (/^tags:\s*$/.test(fmLines[i])) {
      blockStart = i;
      let j = i + 1;
      while (j < fmLines.length && /^[ \t]+- /.test(fmLines[j])) {
        const m = fmLines[j].match(/^[ \t]+- (.+)$/);
        if (m) existing.push(m[1].trim().replace(/^["']|["']$/g, '').trim());
        j++;
      }
      blockEnd = j;
      break;
    }
    // Inline form: `tags: [a, b]`
    const inline = fmLines[i].match(/^tags:\s*\[(.*)\]\s*$/);
    if (inline) {
      blockStart = i;
      blockEnd = i + 1;
      existing = inline[1]
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
      break;
    }
  }

  // Compute new tag set, preserving relative order of existing tags.
  const removeSet = new Set(remove);
  const out: string[] = existing.filter(t => !removeSet.has(t));
  for (const t of add) if (!out.includes(t)) out.push(t);

  // No-op if membership didn't change.
  if (
    blockStart !== -1 &&
    out.length === existing.length &&
    out.every((t, i) => t === existing[i])
  ) return;

  const newBlock = ['tags:', ...out.map(t => `  - ${t}`)];
  if (blockStart === -1) {
    fmLines.push(...newBlock);
  } else {
    fmLines.splice(blockStart, blockEnd - blockStart, ...newBlock);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
