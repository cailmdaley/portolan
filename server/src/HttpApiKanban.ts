/**
 * HttpApiKanban — global kanban view of shuttle-managed fibers.
 *
 * Reads fibers from a felt host (defaults to ~/loom — the loom monorepo,
 * which symlinks every project's `.felt/`), filters to shuttle-managed fibers
 * (those with a `shuttle:` frontmatter block), and groups by lifecycle stage.
 * `tempered` is a tristate verdict field — absent (no verdict yet),
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
 * field. See [[ai-futures/shuttle/constitution-kanban-compost]] for the
 * rationale.
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
import { existsSync, realpathSync } from 'fs';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { getAllFibers, getFiber, type Fiber } from './FiberReader.js';
import type { FiberTreeSnapshot } from './FiberTreeSnapshotStore.js';
import { listShuttleSessions, shuttleSessionName } from './Shuttle.js';
import {
  canonicalFiberRefFromPath,
  canonicalStoreRelativeId,
} from './canonicalFiberRef.js';

const execFileAsync = promisify(execFile);

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
  /**
   * The harness-native session UUID of the most recently dispatched worker,
   * when resume is available. Written by the Shuttle daemon via
   * `shuttle-ctl session-set` after a successful worker spawn.
   *
   * Non-null → the "Resume previous" button on awaiting-review cards is
   * enabled. Absent → button is disabled with a tooltip explaining why.
   *
   * The dispatcher reads this field at next dispatch to invoke the
   * harness-appropriate resume command (e.g. `claude --resume <id>`,
   * `codex resume <id>`, `pi --session <id>`).
   */
  sessionId?: string;
  /**
   * `shuttle.agent` — the agent identifier to dispatch with (e.g. `claude-opus`).
   * Present only when the shuttle block specifies an agent. Used by the
   * fiber-detail modal to show and edit the dispatch agent without opening vellum.
   */
  shuttleAgent?: string;
  /**
   * `shuttle.kind` — `oneshot` (default) or `standing`. Surfaced on the card so
   * the fiber-detail modal can prefill its kind segmented control without an
   * extra round-trip; `undefined` means the fiber has no shuttle block at all
   * (in which case the dispatch panel hides).
   */
  shuttleKind?: 'oneshot' | 'standing';
  /**
   * `shuttle.schedule.expr` — 5-field cron expression for standing roles.
   * Absent for one-shot fibers and for unblocked fibers; present when
   * `shuttleKind === 'standing'`.
   */
  shuttleSchedule?: string;
  /**
   * `shuttle.schedule.tz` — IANA timezone name paired with `shuttleSchedule`.
   * Absent when `shuttleSchedule` is absent.
   */
  shuttleTz?: string;
  /**
   * `shuttle.review.state` — current review state for standing roles.
   * `'awaiting'` means the worker finished a run and is waiting for human
   * review; `'scheduled'` / `'accepted'` means the role is in its normal
   * dispatch-eligible state. Absent for oneshot fibers and fibers with no
   * shuttle block.
   *
   * Surfaced here so the frontend can distinguish "standing role awaiting
   * review" from "standing role in flight" without a round-trip — in
   * particular, `runRequeue` needs to know whether to run `accept` first
   * (awaiting → scheduled) before forcing a dispatch.
   */
  shuttleReviewState?: 'scheduled' | 'awaiting' | 'accepted';
}

export interface KanbanColumns {
  /**
   * Tagged `idea` — the speculative pre-draft column. Off-screen left at
   * rest so drafts stay focused on actual constitutions to review.
   * `idea` takes precedence over `draft` when both are present.
   */
  ideas: KanbanCard[];
  /** shuttle.enabled === false (paused / not yet queued). Hidden from Shuttle dispatch. */
  drafts: KanbanCard[];
  /** shuttle.enabled !== false, status != closed. Queue + active are one bucket. */
  inFlight: KanbanCard[];
  /** Shuttle-block fiber, status=closed && tempered absent (the human-tempering queue). */
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
    ideas: number;
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
   * Executor for remote-origin kanban mutations. When a card's origin isn't
   * `local`, the server computes the semantic shuttle/felt edit locally and
   * ships it through this callback instead of mutating the file directly.
   *
   * The callback owns the agent round-trip (correlation-ID send + reply wait)
   * plus the snapshot-store delta apply, so by the time it resolves the
   * snapshot for `originId` already reflects the new state and the kanban can
   * re-read the refreshed fiber via `remoteSnapshotsProvider`.
   *
   * `path` is relative to the agent's `feltHost/.felt/` (e.g.
   * `cmbx/cmbx.md`); the agent reconstructs the absolute path.
   *
   * If undefined, remote-origin mutations throw a boundary error (preserves
   * Stage 3a behaviour for tests that don't wire an executor).
   */
  remoteTransitionExecutor?: (args: RemoteKanbanMutationRequest) => Promise<void>;
  /** Max tempered cards to return. Defaults to 30. */
  temperedLimit?: number;
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
  /**
   * Test seam: override the shuttle-ctl spawn for local lifecycle transitions.
   * When provided, called instead of `execFileAsync('shuttle-ctl', ...)`.
   * Receives the exact semantic invocation the server would shell out:
   * pause / reopen / close / accept / set-outcome against an explicit
   * `(host, fiberId)` pair. Should throw on failure (same contract as the
   * real execFileAsync call).
   */
  shuttleCtlFn?: (invocation: ShuttleCtlInvocation) => Promise<void>;
  /**
   * Test seam: override the local `felt edit` spawn for tag replacement.
   * Receives the exact add/remove diff the server would shell out.
   */
  feltEditFn?: (invocation: FeltTagEditInvocation) => Promise<void>;
}

export type ShuttleCtlInvocation =
  | { host: string; verb: 'pause' | 'reopen' | 'accept'; fiberId: string }
  | { host: string; verb: 'close'; fiberId: string; tempered?: boolean }
  | { host: string; verb: 'set-outcome'; fiberId: string; outcome: string };

export type RemoteKanbanMutationInvocation =
  | ({ kind: 'shuttle'; path: string } & ShuttleCtlInvocation)
  | { kind: 'felt-tags'; fiberId: string; path: string; tags: string[] };

export type RemoteKanbanMutationRequest =
  RemoteKanbanMutationInvocation & { originId: string };

export type FeltTagEditInvocation = {
  host: string;
  fiberId: string;
  add: string[];
  remove: string[];
};

/**
 * Where a transition can land a card.
 *
 *   drafts          → shuttle-ctl pause (enabled=false; clears verdict/closed-at, reopens if needed)
 *   inFlight        → shuttle-ctl reopen (enabled=true; status=active; clears verdict/closed-at)
 *   awaitingReview  → shuttle-ctl close                    (status=closed; clears `tempered`)
 *   tempered        → shuttle-ctl close --tempered=true    (human-accepted)
 *   composted       → shuttle-ctl close --tempered=false   (human-rejected: mooted, superseded)
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
  | 'ideas'
  | 'drafts'
  | 'inFlight'
  | 'awaitingReview'
  | 'tempered'
  | 'composted'
  // Legacy aliases (queued/active mapped to inFlight)
  | 'queued'
  | 'active';

/**
 * The set of columns the kanban renders. Differs from KanbanTarget in that
 * `ideas` is read-only here (you classify *into* ideas via the `idea` tag,
 * not via a transition target) and KanbanTarget's legacy aliases are absent.
 */
export type KanbanColumn =
  | 'ideas'
  | 'drafts'
  | 'inFlight'
  | 'awaitingReview'
  | 'tempered'
  | 'composted';

/**
 * Classify a fiber into the kanban column it belongs in. The single source
 * of truth for "what column is this?". The rule, in plain English:
 *
 *   1. A standing-role fiber whose worker has finished a run (review.state
 *      = `awaiting`) sits in awaitingReview until the human accepts —
 *      regardless of `status` (standing roles stay `active` permanently;
 *      review.state replaces status as the lifecycle signal).
 *
 *   2. Otherwise, status drives the open/closed split:
 *
 *      open (status !== `closed`):
 *        - `idea` tag         → ideas      (speculative, pre-formal)
 *        - shuttle.enabled=false → drafts  (paused — has thinking, not yet
 *                                           ready to dispatch)
 *        - else              → inFlight   (dispatch-eligible)
 *
 *      closed (status === `closed`):
 *        - tempered=true     → tempered   (human-accepted)
 *        - tempered=false    → composted  (human-rejected — see
 *                                           [[ai-futures/shuttle/constitution-kanban-compost]])
 *        - tempered absent   → awaitingReview (agent handed off, awaiting
 *                                              human verdict)
 *
 * The `idea` tag takes precedence over the enabled split so flipping a
 * fiber idea→draft is a tag edit alone — no need to also touch
 * shuttle.enabled.
 */
export function classifyFiber(f: Fiber): KanbanColumn {
  if (f.shuttleKind === 'standing' && f.shuttleReviewState === 'awaiting') {
    return 'awaitingReview';
  }
  if (f.status !== 'closed') {
    if (f.tags?.includes('idea')) return 'ideas';
    if (f.shuttleEnabled === false) return 'drafts';
    // Standing roles in scheduled/accepted state are dispatch-eligible but
    // dormant — they're waiting for the next cron occurrence, not actively
    // being worked on. Route them to drafts (sorted to the bottom by the
    // drafts comparator below) so inFlight stays focused on what's running
    // or immediately due. The daemon's eligibility check reads the shuttle:
    // block directly; column membership is a view-only signal.
    if (
      f.shuttleKind === 'standing' &&
      (f.shuttleReviewState === 'scheduled' || f.shuttleReviewState === 'accepted')
    ) {
      return 'drafts';
    }
    return 'inFlight';
  }
  if (f.tempered === true) return 'tempered';
  if (f.tempered === false) return 'composted';
  return 'awaitingReview';
}

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

function canonicalRefForEntry(entry: KanbanFiberEntry): { host: string; fiberId: string } {
  if (entry.canonicalPath !== undefined) {
    const ref = canonicalFiberRefFromPath(entry.canonicalPath);
    if (ref !== undefined) return ref;
  }
  return { host: entry.host, fiberId: entry.fiber.id };
}

/** What POST /kanban/transition expects in the body. */
export interface KanbanTransitionRequest {
  fiberId: string;
  target: KanbanTarget;
}

/** What POST /kanban/review-comment expects in the body. */
export interface KanbanReviewCommentRequest {
  fiberId: string;
  /** The directive text — operational steering for the next Shuttle run. */
  directive: string;
  /** How to requeue: 'fresh' spawns a new worker; 'previous' resumes the prior session. */
  resumeMode: 'fresh' | 'previous';
  /**
   * Interactive mode — when true, the dispatcher injects a "don't kill PPID;
   * a human will attach" prelude into the worker's prompt so the worker
   * stays alive after its initial task. Defaults to false (autonomous; the
   * worker exits via kill PPID at the end of its run, current behavior).
   */
  interactive?: boolean;
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
  private readonly listSessions: () => string[];
  private readonly cacheTtlMs: number;
  private readonly shuttleCtlFn: HttpApiKanbanOptions['shuttleCtlFn'];
  private readonly feltEditFn: HttpApiKanbanOptions['feltEditFn'];

  /**
   * Run a shuttle-ctl lifecycle invocation against an explicit
   * `(felt host, fiber id)` pair. Honors the test seam (`shuttleCtlFn`)
   * when set; otherwise spawns `shuttle-ctl` with the standard timeout +
   * buffer and reformats stderr into a meaningful error. Centralized so
   * every local transition routes through the same single-writer boundary.
   */
  private async runShuttleCtl(invocation: ShuttleCtlInvocation): Promise<void> {
    if (this.shuttleCtlFn) {
      await this.shuttleCtlFn(invocation);
      return;
    }

    const args = ['--host', invocation.host, invocation.verb, invocation.fiberId];
    if (invocation.verb === 'close' && invocation.tempered !== undefined) {
      args.push(`--tempered=${invocation.tempered ? 'true' : 'false'}`);
    }
    if (invocation.verb === 'set-outcome') {
      args.push('--outcome', invocation.outcome);
    }

    try {
      await execFileAsync('shuttle-ctl', args, {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    } catch (err: any) {
      const msg = (err?.stderr?.toString?.() || err?.message || String(err)).trim();
      throw new Error(`shuttle-ctl ${args.join(' ')} failed: ${msg}`);
    }
  }

  private async runFeltTagEdit(invocation: FeltTagEditInvocation): Promise<void> {
    if (invocation.add.length === 0 && invocation.remove.length === 0) return;
    if (this.feltEditFn) {
      await this.feltEditFn(invocation);
      return;
    }

    const args = ['-C', invocation.host, 'edit', invocation.fiberId];
    for (const tag of invocation.remove) args.push('--untag', tag);
    for (const tag of invocation.add) args.push('--tag', tag);

    try {
      await execFileAsync('felt', args, {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    } catch (err: any) {
      const msg = (err?.stderr?.toString?.() || err?.message || String(err)).trim();
      throw new Error(`felt ${args.join(' ')} failed: ${msg}`);
    }
  }

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
    this.listSessions = opts.listSessions ?? listShuttleSessions;
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
    this.shuttleCtlFn = opts.shuttleCtlFn;
    this.feltEditFn = opts.feltEditFn;
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
          // No bodies — the kanban card surface doesn't ship body content,
          // and `--body` would inflate the felt subprocess output ~80×.
          return { host, fibers: await getAllFibers(host, { withBody: false }) };
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

      // Shuttle-managed fibers: those with a shuttle: block. Post-cutover,
      // this is the sole eligibility signal. Run `shuttle migrate` once before
      // deploying to backfill blocks on legacy constitution-tagged fibers
      // (see [[ai-futures/portolan/vellum-reader/constitution-vellum-kanban/constitution-shuttle-block-cutover]]).
      const constitutional = merged.filter(({ fiber }) => fiber.hasShuttleBlock === true);

      // Probe live shuttle workers — drives the running-worker indicator on
      // in-flight cards, and bumps them to the top of the column.
      const liveSessions = new Set(this.listSessions());

      const ideas: KanbanCard[] = [];
      const drafts: KanbanCard[] = [];
      const inFlight: KanbanCard[] = [];
      const awaitingReview: KanbanCard[] = [];
      const tempered: KanbanCard[] = [];
      const composted: KanbanCard[] = [];

      const buckets: Record<KanbanColumn, KanbanCard[]> = {
        ideas, drafts, inFlight, awaitingReview, tempered, composted,
      };
      for (const { fiber: f, host, originId, canonicalPath } of constitutional) {
        const card = this.toCard(f, host, originId, byId, liveSessions, canonicalPath);
        buckets[classifyFiber(f)].push(card);
      }

      // Sort:
      //   ideas           : most-recently-created first (sketches, brainstorms)
      //   drafts          : most-recently-created first (these are works-in-progress)
      //   inFlight        : running workers / status:active first, then by createdAt desc
      //   awaitingReview  : most-recently-closed first
      //   tempered        : most-recently-closed first
      //   composted       : most-recently-closed first (the discarded, in reverse chrono)
      ideas.sort(byCreatedAtDesc);
      // Drafts: paused/work-in-progress at top, dormant standing roles at
      // bottom. Standing roles in scheduled/accepted state share this column
      // because they're waiting for cron, not being actively worked on — but
      // they shouldn't crowd out the actual drafts the user is reviewing.
      drafts.sort((a, b) => {
        const aDormantStanding = a.shuttleKind === 'standing' ? 1 : 0;
        const bDormantStanding = b.shuttleKind === 'standing' ? 1 : 0;
        if (aDormantStanding !== bDormantStanding) return aDormantStanding - bDormantStanding;
        return byCreatedAtDesc(a, b);
      });
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
          ideas,
          drafts,
          inFlight,
          awaitingReview,
          tempered: temperedSliced,
          composted,
        },
        totals: {
          ideas: ideas.length,
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
   * Maps target → shuttle-ctl lifecycle verb:
   *   drafts          : pause
   *   inFlight        : reopen
   *   awaitingReview  : close
   *   tempered        : close --tempered=true
   *   composted       : close --tempered=false
   *
   * The agent's "I'm done" handoff is `awaitingReview` (status flip), per the
   * Path B protocol in constitution-shuttle. Setting `tempered: true` is the
   * human-only acceptance signal. This endpoint enforces neither — the human
   * is driving every transition here, so any direction is allowed (including
   * in-flight → tempered to skip review for trusted work).
   *
   * Local writes now go through shuttle-ctl exclusively so status / tempered /
   * closed-at / shuttle.enabled live behind one YAML writer instead of a regex
   * pass racing the shuttle block AST writer.
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
      'ideas',
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
    if (fiber.hasShuttleBlock !== true) {
      throw new Error(
        `kanban only mutates shuttle-managed fibers; ${fiberId} has no shuttle: block`,
      );
    }

    // Ideas column placement is governed by the `idea` tag, not by a
    // shuttle-ctl lifecycle verb (see classifyFiber: `idea` tag takes
    // precedence over the enabled split). So drags into/out of ideas are
    // tag mutations: add `idea` for `→ ideas`, remove `idea` for any
    // other column when the fiber currently lives in ideas. The latter
    // chains into the regular lifecycle path so e.g. `ideas → drafts`
    // strips the tag and pauses in one operation.
    const currentTags = normalizeTagList(fiber.tags ?? []);
    const wasIdea = currentTags.includes('idea');

    if (target === 'ideas') {
      if (wasIdea) {
        // Already in ideas — return a refreshed card without touching disk.
        return this.applyTags(fiberId, currentTags);
      }

      // If the fiber is closed (awaiting review), simply adding the
      // `idea` tag won't move it into Ideas: classification treats `closed`
      // fibers as awaitingReview/tempered/composted regardless of tags.
      // To support the direct drag path "awaitingReview → ideas", reopen
      // the fiber first (pause → drafts) then add the `idea` tag so
      // classification places it into Ideas (the `idea` tag takes
      // precedence for open fibers).
      if (fiber.status === 'closed') {
        if (originId !== 'local') {
          if (!this.remoteTransitionExecutor) {
            throw new Error(
              `remote-origin transitions require remoteTransitionExecutor wiring ` +
                `(fiber ${fiberId} is on origin '${originId}')`,
            );
          }
          // Pause on the remote origin via the executor.
          await this.remoteTransitionExecutor({
            originId,
            path: relativeFeltPath(fiber),
            kind: 'shuttle',
            ...transitionInvocationForTarget(fiber, { host, fiberId: fiber.id }, 'drafts'),
          });
          this.clearFiberPoolCache();
        } else {
          await this.runShuttleCtl(
            transitionInvocationForTarget(fiber, canonicalRefForEntry(entry), 'drafts'),
          );
          this.clearFiberPoolCache();
        }
      }

      // Now add the idea tag (applyTags handles remote vs local).
      return this.applyTags(fiberId, [...currentTags, 'idea']);
    }

    if (wasIdea) {
      // Drag out of ideas: strip the tag first, then fall through to the
      // lifecycle verb so `ideas → drafts` pauses, `ideas → inFlight`
      // reopens, etc. The downstream lifecycle path doesn't read tags
      // (only shuttle-block / status / kind fields, which are unchanged
      // by a tag edit), and the trailing `getFiber` refresh after
      // shuttle-ctl will surface the final post-strip-and-verb state.
      await this.applyTags(
        fiberId,
        currentTags.filter((t) => t !== 'idea'),
      );
    }

    if (originId !== 'local') {
      if (!this.remoteTransitionExecutor) {
        throw new Error(
          `remote-origin transitions require remoteTransitionExecutor wiring ` +
            `(fiber ${fiberId} is on origin '${originId}')`,
        );
      }
      await this.remoteTransitionExecutor({
        originId,
        path: relativeFeltPath(fiber),
        kind: 'shuttle',
        ...transitionInvocationForTarget(fiber, { host, fiberId: fiber.id }, target),
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

    await this.runShuttleCtl(
      transitionInvocationForTarget(fiber, canonicalRefForEntry(entry), target),
    );
    this.clearFiberPoolCache();

    const refreshed = await getFiber(host, fiberId);
    if (!refreshed) throw new Error(`failed to refresh fiber through felt show: ${fiberId}`);
    const refreshedById = new Map(merged.map(({ fiber: f }) => [f.id, f]));
    refreshedById.set(fiberId, refreshed);
    let canonicalAfter: string | undefined;
    try {
      canonicalAfter = realpathSync(path);
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
   * Resolve a fiber by id, replace its tags through `felt edit`, and return
   * the refreshed card. Tags are felt-level qualitative noticings, so this
   * stays outside shuttle-ctl even for shuttle-managed fibers.
   */
  async applyTags(fiberId: string, tags: string[]): Promise<KanbanCard> {
    const { merged } = await this.collectFibers();
    const entry = merged.find(({ fiber }) => fiber.id === fiberId);
    if (!entry) throw new Error(`fiber not found: ${fiberId}`);
    const { fiber, host, originId } = entry;

    const normalized = normalizeTagList(tags);
    const { add, remove } = diffTags(normalizeTagList(fiber.tags ?? []), normalized);

    if (originId !== 'local') {
      if (!this.remoteTransitionExecutor) {
        throw new Error(
          `remote-origin tag edits require remoteTransitionExecutor wiring ` +
            `(fiber ${fiberId} is on origin '${originId}')`,
        );
      }
      await this.remoteTransitionExecutor({
        originId,
        fiberId,
        path: relativeFeltPath(fiber),
        kind: 'felt-tags',
        tags: normalized,
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

    const path = this.fiberPath(host, fiber);
    if (!existsSync(path)) throw new Error(`fiber file missing: ${path}`);

    await this.runFeltTagEdit({ host, fiberId, add, remove });
    this.clearFiberPoolCache();

    const refreshed = await getFiber(host, fiberId);
    if (!refreshed) throw new Error(`failed to refresh fiber through felt show: ${fiberId}`);
    const refreshedById = new Map(merged.map(({ fiber: f }) => [f.id, f]));
    refreshedById.set(fiberId, refreshed);
    let canonicalAfter: string | undefined;
    try {
      canonicalAfter = realpathSync(path);
    } catch {
      canonicalAfter = undefined;
    }
    return this.toCard(refreshed, host, originId, refreshedById, undefined, canonicalAfter);
  }

  /**
   * POST /kanban/review-comment — file a review directive as a typed
   * `review-comment` event on a fiber's felt history.
   *
   * Body: { fiberId, directive, resumeMode: 'fresh' | 'previous' }
   *
   * Shells out to:
   *   felt -C <canonicalHost> history append <canonicalId>
   *        --kind review-comment --summary <directive>
   *
   * **Index-scope correctness:** felt has one index per `.felt/` directory;
   * a fiber that lives under both `~/loom/.felt/ai-futures/portolan/...`
   * (via symlink) and `<portolan>/.felt/...` (the project view) must write
   * history into the canonical store Shuttle dispatches from. We derive that
   * `(host, id)` pair from the fiber's realpath'd md path (`canonicalPath`)
   * rather than re-implementing loom-global slug arithmetic.
   *
   * The directive lands as a separately-queryable typed event. Shuttle's
   * dispatcher reads the latest review-comment via
   * `felt history <id> --kind review-comment --last 1 --json` and inlines
   * it at the top of every dispatch prompt, so the directive survives
   * arbitrarily many intermediate worker handoffs without depending on
   * a chronology window. New directives supersede by being more recent;
   * the worker reads the editorial chain alongside the directive and
   * decides whether it's still in play.
   *
   * `resumeMode` lands in the event payload as `resume_mode` via felt's
   * `--field key=value` flag. Shuttle's dispatcher reads it from the
   * latest review-comment to choose between fresh and resume-previous
   * dispatch — so we always write the event (even with empty directive)
   * to keep the latest review-comment's `resume_mode` aligned with what
   * Cail just clicked. An empty directive is filed with an empty summary;
   * the dispatcher's directive-block renderer suppresses empty summaries
   * so the prompt stays clean.
   *
   * The caller is expected to follow up with POST /kanban/transition to
   * move the card back to inFlight; this endpoint only records the
   * directive and does not change fiber status itself.
   */
  async handleReviewComment(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: KanbanReviewCommentRequest;
    try {
      body = await readJsonBody<KanbanReviewCommentRequest>(req);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 400, { error: `bad request body: ${msg}` });
      return;
    }
    if (!body || typeof body.fiberId !== 'string' || typeof body.directive !== 'string') {
      this.json(res, 400, { error: 'fiberId and directive are required' });
      return;
    }
    if (body.resumeMode !== 'fresh' && body.resumeMode !== 'previous') {
      this.json(res, 400, { error: `resumeMode must be 'fresh' or 'previous'` });
      return;
    }
    // Empty directive is allowed — the user may want to requeue/resume
    // without filing a new comment. We still write the review-comment
    // event so its `resume_mode` field reflects the latest user intent
    // (otherwise an old `resume_mode=previous` event would still trigger
    // resume on a "Requeue fresh" click). The dispatcher suppresses
    // empty-summary directive blocks.
    const directive = body.directive.trim();

    let ref: { host: string; fiberId: string };
    try {
      const { merged } = await this.collectFibers();
      const entry = merged.find(({ fiber }) => fiber.id === body.fiberId);
      if (!entry) {
        this.json(res, 404, { error: `fiber not found: ${body.fiberId}` });
        return;
      }
      ref = canonicalRefForEntry(entry);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 500, { error: `fiber resolution failed: ${msg}` });
      return;
    }

    try {
      // resumeMode lands in the event payload as `resume_mode` via felt's
      // generic `--field key=value` flag. Shuttle's dispatcher reads
      // payload.resume_mode from the latest review-comment to decide
      // between fresh and resume-previous dispatch (see
      // shuttle/lib/shuttle/dispatcher.ex#check_resume_intent). Without
      // this field the dispatcher always falls through to :fresh —
      // which is what was happening before, breaking the "Resume
      // previous" button silently.
      //
      // `interactive` lands in the same payload as `interactive`. When true,
      // the dispatcher injects a "don't kill PPID" prelude so the worker
      // stays alive for the human to attach mid-conversation.
      const interactive = body.interactive === true;
      const feltArgs = [
        '-C', ref.host,
        'history', 'append', ref.fiberId,
        '--kind', 'review-comment',
        '--summary', directive,
        '--field', `resume_mode=${body.resumeMode}`,
      ];
      if (interactive) feltArgs.push('--field', 'interactive=true');
      await execFileAsync('felt', feltArgs);
      this.json(res, 200, { ok: true });
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string })?.stderr?.trim() ||
        (err as { message?: string })?.message ||
        String(err);
      console.error('[Kanban] review-comment append failed:', msg);
      this.json(res, 500, { error: `felt history append failed: ${msg}` });
    }
  }

  // ---------------------------------------------------------------------------
  // Fiber detail modal endpoints
  // ---------------------------------------------------------------------------

  /**
   * GET /kanban/fiber-search?q=<query>&excludeId=<fiberId>
   *
   * Returns fibers from the same felt host for use as parent-fiber candidates
   * in the fiber-detail modal's autocomplete. Excludes `excludeId` and its
   * descendants (a fiber can't be its own parent or a parent of an ancestor).
   *
   * When `q` is empty: returns top-level fibers (depth 1 within the host)
   * from the same project prefix as `excludeId`. When `q` is non-empty:
   * returns all matching fibers ordered by name, up to 30 results.
   *
   * Response: `{ fibers: Array<{ id, name, depth }> }` where `depth` is the
   * number of `/`-separated segments in the id. Depth=1 means top-level
   * within the felt host.
   */
  async handleFiberSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const excludeId = url.searchParams.get('excludeId') ?? '';

    try {
      const { merged } = await this.collectFibers();
      const allFibers = merged.map(({ fiber }) => fiber);

      // Derive project prefix from excludeId. A fiber in `ai-futures/portolan/foo`
      // has project prefix `ai-futures/portolan`. A top-level fiber has no prefix.
      // We scope results to the same project (same first two path segments for
      // nested projects, or same first segment for top-level projects).
      const excludeSegments = excludeId ? excludeId.split('/') : [];
      const projectPrefix = excludeSegments.length >= 2
        ? excludeSegments.slice(0, -1).join('/')
        : excludeSegments[0] ?? '';

      // Filter: same project (id starts with prefix), not excluded, not a
      // descendant of the excluded fiber.
      const candidateFilter = (f: Fiber): boolean => {
        if (!f.id) return false;
        // Exclude self and descendants.
        if (f.id === excludeId) return false;
        if (excludeId && (f.id.startsWith(excludeId + '/'))) return false;
        // Same project prefix.
        if (projectPrefix && !f.id.startsWith(projectPrefix)) return false;
        return true;
      };

      let results: Fiber[];
      if (!q) {
        // No query: return top-level items within the project (direct children
        // of the project prefix). These are the structural anchors the user
        // needs to navigate the parent hierarchy.
        const prefixDepth = projectPrefix ? projectPrefix.split('/').length : 0;
        results = allFibers
          .filter(candidateFilter)
          .filter(f => f.id.split('/').length === prefixDepth + 1);
      } else {
        // Query: search across all project fibers by name or id.
        results = allFibers
          .filter(candidateFilter)
          .filter(f =>
            f.name.toLowerCase().includes(q) ||
            f.id.toLowerCase().includes(q),
          )
          .slice(0, 30);
      }

      // Sort: top-level first, then alphabetically by name.
      results.sort((a, b) => {
        const da = a.id.split('/').length;
        const db = b.id.split('/').length;
        if (da !== db) return da - db;
        return a.name.localeCompare(b.name);
      });

      this.json(res, 200, {
        fibers: results.map(f => ({
          id: f.id,
          name: f.name,
          depth: f.id.split('/').length,
        })),
      });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * GET /kanban/fiber-history?fiberId=<id>&limit=<n>
   *
   * Returns the editorial event chain for a fiber by reading
   * `felt -C <canonicalHost> history <canonicalId> --json --last <limit>`.
   * Used by the fiber-detail modal's history panel — the human's "what
   * happened so far" surface beside the live outcome textarea.
   *
   * Resolution mirrors `/kanban/review-comment`: kanban card ids may be
   * project-local under city-scoped views, so we derive the canonical
   * `(host, id)` pair from the fiber's realpath'd md file before invoking
   * felt. That guarantees we read from the same felt index Shuttle's
   * dispatcher reads, not a stale project-local one.
   *
   * Default limit is 20; clamped to [1, 200]. Response shape:
   *   `{ events: Array<{ occurredAt, actor, kind, summary }> }`
   *
   * Mechanical events (add/edit/rm/external_edit) are excluded — the
   * panel surfaces editorial / typed events only. The endpoint never
   * 500s on felt absence; it returns an empty events array so the
   * panel quietly shows "No history yet" rather than blocking the modal.
   */
  async handleFiberHistory(url: URL, res: ServerResponse): Promise<void> {
    const fiberId = url.searchParams.get('fiberId');
    if (!fiberId) {
      this.json(res, 400, { error: 'fiberId is required' });
      return;
    }
    const limitRaw = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, limitRaw))
      : 20;

    try {
      const { merged } = await this.collectFibers();
      const entry = merged.find(({ fiber }) => fiber.id === fiberId);
      if (!entry) {
        // Fiber not found in any merged host — return empty rather than 404
        // so the modal degrades gracefully when the kanban id mapping
        // hasn't caught up yet.
        this.json(res, 200, { events: [] });
        return;
      }
      const ref = canonicalRefForEntry(entry);

      const { stdout, stderr } = await execFileAsync(
        'felt',
        ['-C', ref.host, 'history', ref.fiberId, '--last', String(limit), '-j'],
        { maxBuffer: 2 * 1024 * 1024, timeout: 15_000 },
      );

      // felt emits `warning: index busy — history unavailable` to stderr and
      // an empty array to stdout when the SQLite index is locked by another
      // writer. Distinguishing this from "fiber genuinely has no events"
      // lets the frontend show a transient "refreshing" state and retry,
      // instead of the misleading "no history yet" message.
      const indexBusy = typeof stderr === 'string' && /index busy/i.test(stderr);

      // felt returns `null` (rather than `[]`) on some empty-history paths;
      // tolerate either shape.
      const parsed = JSON.parse((stdout ?? '').trim() || '[]') as unknown;
      const rawEvents: Array<Record<string, unknown>> = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : [];

      const events = rawEvents
        .filter(
          (ev) =>
            typeof ev['occurred_at'] === 'string' &&
            typeof ev['actor'] === 'string' &&
            typeof ev['event_type'] === 'string',
        )
        .map((ev) => {
          // felt renamed the editorial body key from `summary` → `text`
          // (the event IS the summary; naming its body "summary" was
          // recursive — see felt/cmd/history.go). New events ship under
          // `payload.text`; older ones still use `payload.summary`. Fall
          // back through both so post-rename events don't render empty.
          const payload = (ev['payload'] ?? {}) as Record<string, unknown>;
          const text =
            typeof payload['text'] === 'string' ? payload['text']
            : typeof payload['summary'] === 'string' ? payload['summary']
            : '';
          return {
            occurredAt: ev['occurred_at'] as string,
            actor: ev['actor'] as string,
            kind: ev['event_type'] as string,
            summary: text,
          };
        });

      this.json(res, 200, { events, busy: indexBusy && events.length === 0 });
    } catch (err: unknown) {
      // Quietly degrade — the modal renders "No history yet". A loud 500
      // would block the modal from opening for a non-essential panel.
      const msg = (err as { message?: string })?.message ?? String(err);
      console.warn('[Kanban] fiber-history failed (returning empty):', msg);
      this.json(res, 200, { events: [] });
    }
  }

  /**
   * POST /kanban/fiber-patch
   *
   * Patch a fiber's editable fields from the fiber-detail modal. Supports:
   *   - `outcome`         : free-text outcome string (replaces existing)
   *   - `shuttleAgent`    : agent id string. Alone → `shuttle-ctl set-model`
   *                         (cheap, preserves session.id and review state).
   *                         Bundled with kind/schedule/tz → reshape path.
   *   - `shuttleKind`     : `oneshot` | `standing`. Triggers a reshape
   *                         (uninstall + install/repeat) since the writers
   *                         refuse to clobber an existing block.
   *   - `shuttleSchedule` : 5-field cron expression (only meaningful when
   *                         the resolved kind is `standing`).
   *   - `shuttleTz`       : IANA timezone name (paired with `shuttleSchedule`).
   *   - `parentId`        : new parent fiber id (`felt nest`) or `null` to
   *                         promote to top-level (`felt unnest`).
   *
   * Body: `{ fiberId: string, outcome?: string, shuttleAgent?: string,
   *           shuttleKind?: 'oneshot'|'standing', shuttleSchedule?: string,
   *           shuttleTz?: string, parentId?: string | null }`
   *
   * Response: `{ ok: true, newFiberId?: string }` — `newFiberId` is set
   * when parentId changes and the fiber's id changes as a result.
   *
   * The reshape path goes through `shuttle-ctl uninstall` + `install`/`repeat`
   * rather than direct YAML editing because shuttle-ctl validates cron
   * syntax, IANA tz, and agent-registry membership before writing. Direct
   * frontmatter editing would silently accept invalid blocks the daemon
   * then refuses on the next poll.
   *
   * Reshape is destructive of `session.id`, `review.state`, `last_run_at`,
   * `accepted_run_id`, and `next_due_at`. Acceptable for drafts; for active
   * standing roles the human pays this cost knowingly when they edit the
   * cadence.
   */
  async handleFiberPatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: {
      fiberId: string;
      outcome?: string;
      shuttleAgent?: string;
      shuttleKind?: 'oneshot' | 'standing';
      shuttleSchedule?: string;
      shuttleTz?: string;
      parentId?: string | null;
    };
    try {
      body = await readJsonBody(req);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 400, { error: `bad request body: ${msg}` });
      return;
    }
    if (!body || typeof body.fiberId !== 'string') {
      this.json(res, 400, { error: 'fiberId is required' });
      return;
    }

    try {
      const { merged } = await this.collectFibers();
      const entry = merged.find(({ fiber }) => fiber.id === body.fiberId);
      if (!entry) {
        this.json(res, 404, { error: `fiber not found: ${body.fiberId}` });
        return;
      }
      const { fiber, host, originId } = entry;
      const localRef = canonicalRefForEntry(entry);

      let newFiberId: string | undefined;

      // ── Patch outcome via shuttle-ctl (or the remote agent wrapper) ──────
      if (typeof body.outcome === 'string') {
        const outcome = body.outcome.trim();
        if (originId !== 'local') {
          if (!this.remoteTransitionExecutor) {
            throw new Error(
              `remote-origin outcome edits require remoteTransitionExecutor wiring ` +
                `(fiber ${body.fiberId} is on origin '${originId}')`,
            );
          }
          await this.remoteTransitionExecutor({
            originId,
            host,
            fiberId: fiber.id,
            path: relativeFeltPath(fiber),
            kind: 'shuttle',
            verb: 'set-outcome',
            outcome,
          });
        } else {
          await this.runShuttleCtl({
            host: localRef.host,
            verb: 'set-outcome',
            fiberId: localRef.fiberId,
            outcome,
          });
        }
      }

      // ── Reshape the shuttle block (kind / schedule / tz, optionally agent)
      // Anything that touches kind/schedule/tz forces a full uninstall + install
      // /repeat because the shuttle-ctl writers refuse to clobber an existing
      // block. When *only* agent is changing, the cheaper set-model path below
      // preserves session.id, review history, and next_due_at.
      const wantsReshape =
        body.shuttleKind !== undefined ||
        typeof body.shuttleSchedule === 'string' ||
        typeof body.shuttleTz === 'string';

      if (wantsReshape) {
        const targetKind: 'oneshot' | 'standing' =
          body.shuttleKind ?? fiber.shuttleKind ?? 'oneshot';
        const targetAgent =
          typeof body.shuttleAgent === 'string' && body.shuttleAgent
            ? body.shuttleAgent
            : fiber.shuttleAgent;

        // Preserve enabled state across the reshape — a paused draft must
        // stay paused. shuttle-ctl install defaults to enabled; pass
        // --disabled when the fiber currently sits in drafts.
        const wasDisabled = fiber.shuttleEnabled === false;

        let targetSchedule: string | undefined;
        let targetTz: string | undefined;
        if (targetKind === 'standing') {
          const requestedSchedule =
            typeof body.shuttleSchedule === 'string' ? body.shuttleSchedule.trim() : '';
          const requestedTz =
            typeof body.shuttleTz === 'string' ? body.shuttleTz.trim() : '';
          targetSchedule = requestedSchedule || fiber.shuttleSchedule?.expr;
          targetTz = requestedTz || fiber.shuttleSchedule?.tz || 'UTC';
          if (!targetSchedule) {
            throw new Error(
              'standing-kind shuttle blocks require a schedule (cron expression)',
            );
          }
        }

        const ctlEnv = {
          env: { ...process.env, HOME: process.env.HOME ?? '/tmp' },
          cwd: localRef.host,
        };

        // Uninstall first — install/repeat refuse to clobber. Skip when no
        // block exists yet (the patch can install fresh).
        if (fiber.hasShuttleBlock) {
          await execFileAsync('shuttle-ctl', ['--host', localRef.host, 'uninstall', localRef.fiberId], ctlEnv);
        }

        if (targetKind === 'standing') {
          const args = [
            '--host', localRef.host,
            'repeat', localRef.fiberId,
            '--schedule', targetSchedule!,
            '--tz', targetTz!,
          ];
          if (targetAgent) args.push('--model', targetAgent);
          await execFileAsync('shuttle-ctl', args, ctlEnv);
        } else {
          const args = ['--host', localRef.host, 'install', localRef.fiberId];
          if (targetAgent) args.push('--model', targetAgent);
          if (wasDisabled) args.push('--disabled');
          await execFileAsync('shuttle-ctl', args, ctlEnv);
        }
      } else if (typeof body.shuttleAgent === 'string' && body.shuttleAgent) {
        // Agent-only change → set-model preserves session.id and review state.
        await execFileAsync('shuttle-ctl', ['--host', localRef.host, 'set-model', localRef.fiberId, body.shuttleAgent], {
          env: { ...process.env, HOME: process.env.HOME ?? '/tmp' },
          cwd: localRef.host,
        });
      }

      // ── Reparent via felt nest / felt unnest ──────────────────────────────
      if ('parentId' in body) {
        if (body.parentId === null || body.parentId === '') {
          // Promote to top-level.
          await execFileAsync('felt', ['-C', localRef.host, 'unnest', localRef.fiberId]);
          const segments = localRef.fiberId.split('/');
          newFiberId = segments[segments.length - 1];
        } else {
          const parentEntry = merged.find(({ fiber: candidate }) => candidate.id === body.parentId);
          if (!parentEntry) {
            throw new Error(`parent fiber not found: ${body.parentId}`);
          }
          const parentRef = canonicalRefForEntry(parentEntry);
          if (parentRef.host !== localRef.host) {
            throw new Error(
              `cannot reparent across felt hosts (${localRef.host} → ${parentRef.host})`,
            );
          }
          await execFileAsync('felt', ['-C', localRef.host, 'nest', localRef.fiberId, parentRef.fiberId]);
          const segments = localRef.fiberId.split('/');
          newFiberId = `${parentRef.fiberId}/${segments[segments.length - 1]}`;
        }
      }

      this.clearFiberPoolCache();
      this.json(res, 200, { ok: true, ...(newFiberId ? { newFiberId } : {}) });
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string })?.stderr?.trim() ||
        (err as { message?: string })?.message ||
        String(err);
      console.error('[Kanban] fiber-patch failed:', msg);
      this.json(res, 500, { error: msg });
    }
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

    const runningWorker = resolveRunningWorker(f.id, liveSessions, canonicalPath);

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
      sessionId: f.shuttleSessionId,
      shuttleAgent: f.shuttleAgent,
      shuttleKind: f.shuttleKind,
      shuttleSchedule: f.shuttleSchedule?.expr,
      shuttleTz: f.shuttleSchedule?.tz,
      shuttleReviewState: f.shuttleReviewState,
    };
  }

  private emptyResponse(): KanbanResponse {
    return {
      feltHost: this.feltHost,
      columns: { ideas: [], drafts: [], inFlight: [], awaitingReview: [], tempered: [], composted: [] },
      totals: { ideas: 0, drafts: 0, inFlight: 0, awaitingReview: 0, tempered: 0, composted: 0 },
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

function resolveRunningWorker(
  fiberId: string,
  liveSessions: Set<string>,
  canonicalPath?: string,
): string | undefined {
  // Prefer the canonical-store id when we have one — shuttle's session names
  // are keyed off it, so this is an exact-match probe with no namespace
  // ambiguity. Only present for local fibers (canonicalPath set in
  // collectFibersFresh); remote-origin fibers fall through to the fiber-id
  // path below.
  if (canonicalPath !== undefined) {
    const canonicalId = canonicalStoreRelativeId(canonicalPath);
    if (canonicalId !== undefined) {
      const session = shuttleSessionName(canonicalId);
      if (liveSessions.has(session)) return session;
    }
  }

  // No canonical path (remote fibers): exact match against the fiber id as
  // the kanban view sees it. Then fall back to a slash-boundary suffix
  // probe in either direction so a worker dispatched under a more- or
  // less-qualified namespace still surfaces in scoped/global views.
  const exact = shuttleSessionName(fiberId);
  if (liveSessions.has(exact)) return exact;
  const fiberIdSuffix = `/${fiberId}`;
  for (const session of [...liveSessions].sort()) {
    if (session.endsWith(fiberIdSuffix)) return session;
    const tail = session.startsWith('shuttle-')
      ? session.slice('shuttle-'.length)
      : null;
    if (tail !== null && fiberId.endsWith(`/${tail}`)) return session;
  }
  return undefined;
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

// ── Mutation helpers ─────────────────────────────────────────────────────────

function transitionInvocationForTarget(
  fiber: Fiber,
  ref: { host: string; fiberId: string },
  target: KanbanTarget,
): ShuttleCtlInvocation {
  const isStandingAccept =
    (target === 'inFlight' ||
      target === 'queued' ||
      target === 'active' ||
      target === 'tempered') &&
    fiber.shuttleKind === 'standing' &&
    fiber.shuttleReviewState === 'awaiting';

  if (isStandingAccept) return { host: ref.host, verb: 'accept', fiberId: ref.fiberId };
  if (target === 'drafts') return { host: ref.host, verb: 'pause', fiberId: ref.fiberId };
  if (target === 'inFlight' || target === 'queued' || target === 'active') {
    return { host: ref.host, verb: 'reopen', fiberId: ref.fiberId };
  }
  if (target === 'awaitingReview') return { host: ref.host, verb: 'close', fiberId: ref.fiberId };
  if (target === 'tempered') return { host: ref.host, verb: 'close', fiberId: ref.fiberId, tempered: true };
  return { host: ref.host, verb: 'close', fiberId: ref.fiberId, tempered: false };
}

function normalizeTagList(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function diffTags(current: string[], next: string[]): { add: string[]; remove: string[] } {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    add: next.filter((tag) => !currentSet.has(tag)),
    remove: current.filter((tag) => !nextSet.has(tag)),
  };
}
