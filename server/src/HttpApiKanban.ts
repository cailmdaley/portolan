/**
 * HttpApiKanban — three-surface kanban view of shuttle-managed fibers.
 *
 * Reads fibers from a felt host (defaults to ~/loom — the loom monorepo,
 * which symlinks every project's `.felt/`), filters to shuttle-managed
 * fibers plus open/active human due-date fibers, and lays them out across
 * three surfaces shaped for distinct cognitive modes:
 *
 *   • Now — the desk. Three lifecycle columns (Drafts / In Flight /
 *     Awaiting Review) for what's actively being worked.
 *   • Timeline — the road behind and ahead. Past landings (closed
 *     fibers, both tempered and composted) on the left; future-dated
 *     soon-bucketed fibers on the right; an "anytime soon" pool below
 *     for soon fibers without a due date.
 *   • Stash — visible cluster grid keyed on containment-path. Holds
 *     `horizon: stashed` fibers (warm clusters first, then `cold: true`
 *     held-open clusters).
 *
 * Top-level `horizon:` narrows to `now | soon | stashed`; the legacy
 * `later`/`someday` values are rewritten by
 * scripts/migrate-kanban-horizon-three-surface.ts before this code reads
 * them. `cold: bool` (default false) flags a stashed fiber for
 * held-open clustering.
 *
 * **Auto-pause-on-defer.** A fiber is dispatch-eligible iff
 *
 *     shuttle.enabled !== false  AND  effectiveHorizon === 'now'
 *
 * — see `effectiveDispatchEligible`. `effectiveHorizon` honors due-date
 * drift (`due` within 2 days promotes effective horizon to `now`), so a
 * stashed-but-deadline-bearing fiber still dispatches. classifyFiber
 * uses this predicate to gate `inFlight`, which is why "In Flight Soon"
 * is structurally impossible: enabled + horizon:soon lands in drafts.
 *
 * `tempered` is a tristate verdict field — absent (no verdict yet),
 * `true` (accepted), `false` (composted). classifyFiber emits:
 *
 *   - drafts          : human due-date OR enabled-but-deferred OR
 *                       shuttle.enabled=false (the desk's "needs work
 *                       or attention" pile)
 *   - scheduled       : dormant standing role (enabled, status open,
 *                       reviewState ∈ {scheduled, accepted}). Waiting
 *                       for cron, not for a human. The response routing
 *                       layer always lifts these onto
 *                       timeline.futureDated | anytimeSoon at their
 *                       next cron occurrence; a standing role is a
 *                       commitment with a date, not a draft.
 *   - inFlight        : enabled + effectiveHorizon=now (the only
 *                       dispatch-eligible bucket)
 *   - awaitingReview  : status=closed + tempered absent, OR standing
 *                       role with review.state=awaiting
 *   - tempered        : status=closed + tempered=true (human-accepted)
 *   - composted       : status=closed + tempered=false (human-rejected)
 *   - ideas           : `idea` tag, status open/active (speculative pool;
 *                       UI keeps these off-screen-left of the three surfaces)
 *
 * The response shape mirrors the three surfaces directly so the frontend
 * never reclassifies (see [[gotchas/gotcha-kanban-frontend-classifier-
 * drift]] for what drift looked like). `timeline.past` merges tempered
 * and composted; the card carries `tempered: bool` so the frontend can
 * render the visual difference. Ideas stay alongside as their own list.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { URL } from 'url';
import { existsSync, realpathSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import YAML from 'yaml';
import { CronExpressionParser } from 'cron-parser';
import { getAllFibers, getFiber, type Fiber } from './FiberReader.js';
import type { FiberTreeSnapshot } from './FiberTreeSnapshotStore.js';
import { listShuttleSessions, shuttleSessionName } from './Shuttle.js';
import {
  canonicalFiberRefFromPath,
  canonicalStoreRelativeId,
} from './canonicalFiberRef.js';

const execFileAsync = promisify(execFile);

export const KANBAN_HORIZONS = ['now', 'soon', 'stashed'] as const;
export type KanbanHorizon = typeof KANBAN_HORIZONS[number];
const HORIZON_SET = new Set<string>(KANBAN_HORIZONS);
/** Legacy values the migration script rewrites; rejected by `POST
 *  /kanban/horizon`. Keeping a parallel set lets validators give a
 *  helpful "run the migration first" error rather than a bare 400. */
const LEGACY_HORIZONS = new Set<string>(['later', 'someday']);
// Drift window: a `due:` within this distance promotes a soon/stashed
// fiber back onto the desk as a deadline-bearing draft. Set to 2 days
// so true imminence (today + tomorrow) still earns desk presence, but
// anything 3+ days out lives where the user planned it — on the
// calendar — instead of crowding the desk. The two failure modes the
// drift window has to balance: an overwhelming desk that hides what
// actually matters, vs. quietly-soon deadlines that get missed because
// they live on the calendar alone. Two days threads that gap.
const HORIZON_DRIFT_MS = 2 * 24 * 60 * 60 * 1000;

// Forward-looking window for dormant standing roles on the timeline.
// A standing role whose next cron occurrence falls within this window
// renders on the timeline strip (futureDated); further out it lives in
// the anytimeSoon pool below the strip so a monthly cron isn't invisible
// for 16/30 days. Must match the frontend's `TIMELINE_FUTURE_DAYS` in
// `src/ui/KanbanModal.ts` — they're the same conceptual window.
const STANDING_TIMELINE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

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
  due?: string;
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
   * vellum collection's fiber graph is keyed by these project-relative
   * slugs, so this is what the frontend hands to `navigate()`.
   */
  projectSlug?: string;
  /**
   * Fiber id in the canonical felt store that Shuttle reads. In city-scoped
   * kanban views `id` may be project-relative (for Vellum navigation), while
   * the Shuttle daemon is registered against loom/canonical ids.
   */
  shuttleFiberId?: string;
  /**
   * The harness-native session UUID of the most recently dispatched worker
   * when the frontmatter still carries one. This is only a card hint; Resume
   * does not depend on it because Shuttle resolves the real session at
   * dispatch time, including fallback to felt history.
   */
  sessionId?: string;
  /** `shuttle.enabled`, surfaced so transition requests can carry card context. */
  shuttleEnabled?: boolean;
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
  /**
   * ISO timestamp of the next cron occurrence, computed from
   * `shuttleSchedule.expr` + `shuttleSchedule.tz` for dormant standing
   * roles only — i.e. `shuttleKind=standing` + status open + enabled +
   * `reviewState ∈ {scheduled, accepted}`. Absent in every other case
   * (oneshot, paused, running, awaiting review, closed, malformed cron).
   *
   * The kanban routing layer uses this field to lift dormant standing
   * roles out of `now.drafts` onto `timeline.futureDated` (within the
   * ±14d strip window) or `timeline.anytimeSoon` (further out). The
   * lifecycle column from `classifyFiber` is still `drafts`; only the
   * *surface* changes. A standing role is a commitment with a date,
   * not a draft.
   *
   * The frontend timeline strip uses `card.nextLaunchAt ?? card.due`
   * for day-column placement.
   */
  nextLaunchAt?: string;
  /** Raw valid `horizon:` value from fiber frontmatter, if present. */
  storedHorizon?: KanbanHorizon;
  /**
   * Surface this card lives on after due-date promotion. `now` is the
   * desk, `soon` is the timeline, `stashed` is the cluster grid.
   * Tempered/composted cards always carry `now` here — their placement
   * in `timeline.past` is driven by status=closed, not horizon.
   */
  effectiveHorizon: KanbanHorizon;
  /** True when `due:` pulls a non-now stored horizon into the now surface. */
  drifted: boolean;
  /**
   * Top-level `cold:` flag (default false). When stashed, drives held-
   * open cluster placement on the frontend. Always defined for stashed
   * cards; we still emit it on other surfaces so a card moving between
   * surfaces keeps a stable shape.
   */
  cold?: boolean;
}

/**
 * The Now surface — the desk. Three lifecycle columns rendered as a
 * dense board. Cards routed here have effectiveHorizon=now AND are
 * either open or recently closed waiting on a verdict.
 */
export interface KanbanNowSurface {
  /**
   * Open fibers that aren't dispatch-eligible right now. Includes:
   *   • Shuttle-managed fibers paused or in dormant standing rotation,
   *   • Human due-date cards (no shuttle block),
   *   • Enabled fibers whose horizon was deferred (auto-pause-on-defer:
   *     enabled+horizon=soon|stashed lands here, not inFlight).
   */
  drafts: KanbanCard[];
  /** The only dispatch-eligible bucket: enabled + effectiveHorizon=now. */
  inFlight: KanbanCard[];
  /**
   * status=closed + tempered absent, OR standing role with
   * review.state=awaiting. The "you owe a verdict" pile.
   */
  awaitingReview: KanbanCard[];
}

/**
 * The Timeline surface — the road behind and ahead. Past landings on
 * the left, future-dated soon fibers on the right, an anytime-soon pool
 * below for soon fibers without a due date.
 *
 * Tempered and composted cards are both in `past`; the frontend keys
 * off `card.tempered` (true/false) to render the visual difference
 * (bright vs dim+strikethrough). The cap on how far back the timeline
 * shows is a frontend rendering concern — past holds every closed
 * fiber in the resolved hosts.
 */
export interface KanbanTimelineSurface {
  /**
   * status=closed, both tempered=true and tempered=false, sorted by
   * closedAt descending. The frontend caps render window (~30 days)
   * and ignores tempered=undefined (those route to now.awaitingReview).
   */
  past: KanbanCard[];
  /**
   * Rendered at a day-column on the strip. Includes both:
   *   • drafts/awaitingReview cards with horizon=soon + due
   *   • dormant standing roles whose next cron occurrence falls within
   *     the ±14d strip window (placed at `nextLaunchAt`'s day-column)
   * The frontend reads `card.nextLaunchAt ?? card.due` for placement.
   */
  futureDated: KanbanCard[];
  /**
   * Rendered in the anytime pool below the strip. Includes both:
   *   • drafts/awaitingReview cards with horizon=soon without a due date
   *   • dormant standing roles whose next cron occurrence falls outside
   *     the strip window (so a monthly cron stays visible between firings)
   */
  anytimeSoon: KanbanCard[];
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

/**
 * Counts for every renderable bucket. Used by the frontend chrome to
 * print "3 drafts · 2 in flight · 19 stashed" without re-counting from
 * the arrays. `temperedTotal` is reserved for the historical recent-N
 * slicing logic in case it ever returns; today we emit every closed
 * fiber in `timeline.past`.
 */
export interface KanbanTotals {
  ideas: number;
  drafts: number;
  inFlight: number;
  awaitingReview: number;
  past: number;
  futureDated: number;
  anytimeSoon: number;
  stash: number;
}

export interface KanbanResponse {
  feltHost: string;
  /** Now surface — the desk (3 columns). */
  now: KanbanNowSurface;
  /** Timeline surface — past/future/anytime-soon, one horizontal axis. */
  timeline: KanbanTimelineSurface;
  /**
   * Stash surface — `horizon: stashed`. The frontend clusters by
   * containment-path's first meaningful project token; we emit a flat
   * array so future cluster-key conventions don't require a server
   * deploy. Warm clusters (`cold !== true`) and held-open clusters
   * (`cold === true`) intermix; the frontend partitions on render.
   */
  stash: KanbanCard[];
  /**
   * Tagged `idea` — speculative pool. Off-screen-left of the three
   * surfaces; conceptually overlaps with stash, but merging is out of
   * scope (see constitution-kanban-three-surfaces "Out"). Eligible:
   * status open/active and the `idea` tag is present.
   */
  ideas: KanbanCard[];
  totals: KanbanTotals;
  /**
   * Historical: total tempered count before any recent-N slicing.
   * Today we always emit every closed fiber in `timeline.past`, so
   * `temperedTotal === past.filter(c => c.tempered === true).length`.
   * Kept for client-side compatibility.
   */
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
   * Read-only Shuttle diagnostics reported by remote agents. These are
   * operator evidence only: dispatch remains owned by the Shuttle daemon.
   */
  shuttleDiagnostics: {
    remoteSnapshots: RemoteShuttleSnapshotDiagnostic[];
  };
  /**
   * Present for a scoped remote-origin Kanban view. The current remote
   * snapshot protocol is origin-scoped, so this tells the frontend when an
   * apparently-empty board actually means "waiting for that remote agent".
   */
  remoteScope?: {
    originId: string;
    hostname: string;
  };
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
   * Latest read-only Shuttle snapshots retained from remote agents. Unlike
   * remoteSnapshotsProvider, this does not contribute fibers to the board;
   * it only lets the Kanban operator surface report what each remote agent
   * observed about Shuttle eligibility.
   */
  remoteShuttleDiagnosticsProvider?: () => RemoteShuttleSnapshotDiagnostic[];
  /**
   * Optional origin filter for snapshot-backed Kanban views. Used by
   * `?cityId=<remote-city>` so the scoped view is not
   * global-local-plus-all-remotes.
   */
  remoteOriginFilter?: string;
  /**
   * Optional remote felt-host filter paired with `remoteOriginFilter`.
   * Remote city-scoped views must only render a snapshot explicitly rooted at
   * that city path. Falling back to an origin-wide `~/loom` snapshot makes a
   * focused city look authoritative while showing stale cross-project fibers.
   */
  remoteFeltHostFilter?: string;
  /**
   * Include local filesystem walks in this view. Defaults to true. Remote
   * city-scoped views set this false so `/kanban?cityId=<remote>` is not
   * polluted by local cards.
   */
  includeLocalFibers?: boolean;
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
   * Test seam / daemon boundary: invoke a Shuttle lifecycle action by id.
   * Portolan owns kanban target interpretation; Shuttle owns the lifecycle
   * action vocabulary and mutation.
   */
  shuttleActionInvokerFn?: (request: ShuttleActionInvokeRequest) => Promise<void>;
  /**
   * Test seam / daemon boundary: resolve a Kanban target to Shuttle's
   * canonical lifecycle action id.
   */
  shuttleActionResolverFn?: (request: ShuttleActionResolveRequest) => Promise<ShuttleAction>;
  /**
   * Test seam: override the local `felt edit` spawn for tag replacement.
   * Receives the exact add/remove diff the server would shell out.
   */
  feltEditFn?: (invocation: FeltTagEditInvocation) => Promise<void>;
  /**
   * Test seam: override the local `felt edit --status` spawn for human-card
   * close transitions. Receives the host + fiber id + target status.
   */
  feltStatusEditFn?: (invocation: FeltStatusEditInvocation) => Promise<void>;
}

export type FeltStatusEditInvocation = {
  host: string;
  fiberId: string;
  status: 'open' | 'active' | 'closed';
};

export interface RemoteShuttleSnapshotDiagnostic {
  originId: string;
  receivedAt: string;
  eligibleCount: number | null;
  blockedCount: number | null;
  orphanCount: number | null;
  snapshot?: unknown;
}

export type ShuttleCtlInvocation =
  | { host: string; verb: 'pause' | 'reopen' | 'accept' | 'resume'; fiberId: string }
  | { host: string; verb: 'close'; fiberId: string; tempered?: boolean }
  | {
      host: string;
      verb: 'install';
      fiberId: string;
      agent?: string;
      disabled?: boolean;
      projectDir?: string;
    }
  | { host: string; verb: 'set-outcome'; fiberId: string; outcome: string }
  // dispatch with adHoc:true for standing roles fires a manual run that
  // does not consume the next scheduled occurrence (synthetic adhoc-* run
  // id; next_due_at preserved). On oneshots or with adHoc:false, behavior
  // matches `shuttle-ctl dispatch <fiber>` directly.
  | { host: string; verb: 'dispatch'; fiberId: string; adHoc?: boolean };

export type ShuttleActionId =
  | 'pause'
  | 'reopen'
  | 'accept-run'
  | 'continue-run-fresh'
  | 'continue-run-previous'
  | 'dispatch-ad-hoc'
  | 'close-awaiting-review'
  | 'close-tempered'
  | 'close-composted';

export type ShuttleAction = {
  id: ShuttleActionId;
  invocation?: {
    verb?: string;
    ad_hoc?: boolean;
    tempered?: boolean;
    resume_mode?: 'fresh' | 'previous';
  };
};

export type ShuttleActionInvokeRequest = {
  fiber: Fiber;
  fiberId: string;
  action: ShuttleActionId;
};

export type ShuttleActionResolveRequest = {
  fiber: Fiber;
  fiberId: string;
  target: KanbanTarget;
};

export type RemoteKanbanMutationInvocation =
  | ({ kind: 'shuttle'; path: string } & ShuttleCtlInvocation)
  | { kind: 'felt-tags'; fiberId: string; path: string; tags: string[] }
  | {
      kind: 'felt-history';
      fiberId: string;
      path: string;
      historyKind: string;
      summary: string;
      historyFields?: Record<string, string>;
    }
  | {
      kind: 'felt-horizon';
      fiberId: string;
      path: string;
      horizon: KanbanHorizon | null;
      /** Optional `cold:` flag; only meaningful with horizon='stashed'.
       *  Omit (or pass undefined) to leave the existing `cold:` line
       *  alone; explicit `false` clears it; `true` writes/updates it. */
      cold?: boolean;
      /** Optional `due:` ISO timestamp. Omit to leave alone; `null` to
       *  clear; a string to write. Lets timeline-date drags carry the
       *  due date through the same atomic write as the surface change. */
      due?: string | null;
    };

export type RemoteKanbanMutationRequest =
  RemoteKanbanMutationInvocation & { originId: string; feltHost: string };

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
  | 'scheduled'
  | 'inFlight'
  | 'awaitingReview'
  | 'tempered'
  | 'composted';

/**
 * Classify a fiber into the kanban column it belongs in. The single source
 * of truth for "what column is this?". The rule, in plain English:
 *
 *   1. A live tmux worker for an open fiber overrides everything — the
 *      file may not have caught up yet (workers write review.state only
 *      on exit), and the user dragging a card and seeing it stay in
 *      drafts is the dissonance we're avoiding.
 *
 *   2. A standing-role fiber whose worker has finished a run
 *      (review.state = `awaiting`) sits in awaitingReview until the
 *      human accepts — regardless of `status` (standing roles stay
 *      `active` permanently; review.state replaces status as the
 *      lifecycle signal).
 *
 *   3. Otherwise, status drives the open/closed split:
 *
 *      open (status !== `closed`):
 *        - no shuttle block      → drafts    (human due-date card;
 *                                             visible, not dispatchable)
 *        - `idea` tag            → ideas     (speculative pool; UI keeps
 *                                             these off-screen-left)
 *        - shuttle.enabled=false → drafts    (paused — has thinking,
 *                                             not yet ready to dispatch)
 *        - dormant standing role → drafts    (scheduled/accepted state;
 *                                             waiting for next cron tick)
 *        - **not effectiveDispatchEligible** → drafts (auto-pause-on-
 *                                             defer: enabled+horizon=soon
 *                                             or stashed without a near
 *                                             due-date → drafts, not
 *                                             inFlight; see
 *                                             effectiveDispatchEligible)
 *        - else                  → inFlight  (enabled + horizon=now or
 *                                             due within 2 days)
 *
 *      closed (status === `closed`):
 *        - tempered=true   → tempered   (human-accepted)
 *        - tempered=false  → composted  (human-rejected, see
 *                                        [[ai-futures/shuttle/constitution-kanban-compost]])
 *        - tempered absent → awaitingReview (agent handed off,
 *                                            awaiting human verdict)
 *
 * The `idea` tag takes precedence over the enabled split so flipping a
 * fiber idea→draft is a tag edit alone — no need to also touch
 * shuttle.enabled. The horizon split lives one rung lower so an idea-
 * tagged fiber on the timeline still routes to ideas (UI semantics
 * survive even if a user defers an idea).
 *
 * The kanban response splits classifyFiber's output across three
 * surfaces: now (drafts/inFlight/awaitingReview), timeline (past:
 * tempered+composted), stash (horizon=stashed, drawn from drafts), and
 * the off-screen ideas pool. The classifier itself doesn't care which
 * surface — it produces a flat label that the handler routes.
 */
export function classifyFiber(
  f: Fiber,
  opts: { runningWorker?: boolean } = {},
): KanbanColumn {
  if (opts.runningWorker && f.status !== 'closed' && f.hasShuttleBlock === true) {
    return 'inFlight';
  }

  if (f.shuttleKind === 'standing' && f.shuttleReviewState === 'awaiting') {
    return 'awaitingReview';
  }
  if (f.status !== 'closed') {
    if (f.hasShuttleBlock !== true) return 'drafts';
    if (f.tags?.includes('idea')) return 'ideas';
    if (f.shuttleEnabled === false) return 'drafts';
    // Standing roles in scheduled/accepted state are dispatch-eligible but
    // dormant — waiting for the next cron occurrence, not actively being
    // worked on. They get their own lifecycle column (`scheduled`); the
    // response routing layer reads `card.nextLaunchAt` and routes the
    // whole bucket onto timeline.futureDated | anytimeSoon at the next
    // cron occurrence. `scheduled` is a read-only label (like `ideas`,
    // `tempered`, `composted`) — drag-into doesn't make sense without
    // specifying the schedule, which happens via the fiber-detail modal.
    if (
      f.shuttleKind === 'standing' &&
      (f.shuttleReviewState === 'scheduled' || f.shuttleReviewState === 'accepted')
    ) {
      return 'scheduled';
    }
    // Auto-pause-on-defer: a shuttle-enabled fiber whose effective
    // horizon is anything other than `now` lands in drafts, not
    // inFlight. The horizon was deferred (soon or stashed) without a
    // due-date promotion, so the human took it off the desk; the
    // kanban respects that. shuttle.enabled stays true so the
    // underlying contract is preserved; pulling-forward to horizon=now
    // (or a near due date) restores eligibility on the next render.
    if (!effectiveDispatchEligible(f)) return 'drafts';
    return 'inFlight';
  }
  if (f.tempered === true) return 'tempered';
  if (f.tempered === false) return 'composted';
  return 'awaitingReview';
}

/**
 * The single eligibility predicate: a fiber is dispatch-eligible iff
 *
 *     shuttle.enabled !== false  AND  effectiveHorizon === 'now'
 *
 * `effectiveHorizon` honors due-date drift (a `due:` within 2 days
 * promotes effectiveHorizon to `now`), so a stashed fiber with an
 * imminent deadline is still picked up — the human committed to a
 * date and the kanban trusts it.
 *
 * NB: this predicate is the kanban view's source of truth. The Shuttle
 * daemon (in ~/Documents/projects/shuttle/) does not currently consult
 * `horizon:` directly; it reads `shuttle.enabled` only. That means a
 * paused+enabled-via-horizon fiber would still get dispatched on the
 * next daemon poll. The cleanest fix is daemon-side (extend
 * `lib/shuttle/poller.ex eligible?/2`); until then, the kanban renders
 * the card in drafts (so the human doesn't see it as in flight), and
 * the existing drag-to-defer flow can compose with `shuttle-ctl pause`
 * if the daemon's behavior becomes a problem in practice.
 */
export function effectiveDispatchEligible(
  f: Pick<Fiber, 'shuttleEnabled' | 'horizon' | 'due'>,
  nowMs: number = Date.now(),
): boolean {
  if (f.shuttleEnabled === false) return false;
  return effectiveHorizon(f, nowMs).effectiveHorizon === 'now';
}

export function effectiveHorizon(
  f: Pick<Fiber, 'due' | 'horizon'>,
  nowMs: number = Date.now(),
): { storedHorizon?: KanbanHorizon; effectiveHorizon: KanbanHorizon; drifted: boolean } {
  const storedHorizon = normalizeHorizon(f.horizon);
  const dueMs = parseDueMs(f.due);
  const duePromotesToNow = dueMs !== undefined && dueMs - nowMs <= HORIZON_DRIFT_MS;

  if (duePromotesToNow) {
    return {
      storedHorizon,
      effectiveHorizon: 'now',
      drifted: storedHorizon !== undefined && storedHorizon !== 'now',
    };
  }

  return {
    storedHorizon,
    effectiveHorizon: storedHorizon ?? 'now',
    drifted: false,
  };
}

function normalizeHorizon(value: unknown): KanbanHorizon | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return HORIZON_SET.has(trimmed) ? trimmed as KanbanHorizon : undefined;
}

/**
 * Compute the ISO timestamp of the next cron occurrence for a dormant
 * standing-role fiber — the schedule's "due date" as far as the kanban
 * timeline is concerned. Returns undefined for anything not eligible
 * for next-launch placement:
 *
 *   - oneshot fibers (no schedule)
 *   - closed fibers (lifecycle is over)
 *   - paused (`shuttleEnabled === false`) — these belong on the desk
 *     as drafts, regardless of schedule
 *   - awaiting review (`shuttleReviewState === 'awaiting'`) — these
 *     belong in awaitingReview; the next launch is gated on the
 *     human's verdict, not on the cron
 *   - missing or malformed cron expressions
 *
 * The kanban routing layer uses this to lift dormant standing roles
 * out of now.drafts onto timeline.futureDated|anytimeSoon. A standing
 * role is a commitment with a date, not a draft.
 *
 * Timezone defaults to UTC when `shuttleSchedule.tz` is absent — the
 * write path enforces a tz on every standing-role schedule, so the
 * fallback is mostly defensive.
 */
export function nextStandingLaunch(
  f: Pick<
    Fiber,
    'shuttleKind' | 'shuttleSchedule' | 'shuttleEnabled' | 'shuttleReviewState' | 'status'
  >,
  nowMs: number = Date.now(),
): string | undefined {
  if (f.shuttleKind !== 'standing') return undefined;
  if (f.status === 'closed') return undefined;
  if (f.shuttleEnabled === false) return undefined;
  if (f.shuttleReviewState === 'awaiting') return undefined;
  const expr = f.shuttleSchedule?.expr;
  if (typeof expr !== 'string' || !expr.trim()) return undefined;
  const rawTz = f.shuttleSchedule?.tz;
  const tz = typeof rawTz === 'string' && rawTz.trim() ? rawTz : 'UTC';
  try {
    const it = CronExpressionParser.parse(expr, {
      tz,
      currentDate: new Date(nowMs),
    });
    return it.next().toISOString() ?? undefined;
  } catch {
    return undefined;
  }
}

function parseDueMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function shouldIncludeInKanban(fiber: Fiber): boolean {
  if (fiber.hasShuttleBlock === true) return true;
  return (fiber.status === 'open' || fiber.status === 'active') && parseDueMs(fiber.due) !== undefined;
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

function entryFromLocalCard(card: KanbanCard | undefined): KanbanFiberEntry | null {
  if (!card || card.originId !== 'local') return null;
  const displayRef = canonicalFiberRefFromPath(card.path);
  if (!displayRef) return null;

  let canonicalPath: string | undefined;
  try {
    canonicalPath = realpathSync(card.path);
  } catch {
    return null;
  }

  return {
    fiber: fiberFromCard(card),
    host: displayRef.host,
    originId: 'local',
    canonicalPath,
  };
}

function fiberFromCard(card: KanbanCard): Fiber {
  return {
    id: card.id,
    name: card.name,
    status: card.status,
    kind: 'task',
    priority: 2,
    createdAt: card.createdAt,
    outcome: card.outcome,
    due: card.due,
    horizon: card.storedHorizon,
    closedAt: card.closedAt,
    tags: card.tags,
    dependsOn: card.dependsOn,
    tempered: card.tempered,
    hasShuttleBlock: card.shuttleKind !== undefined,
    shuttleEnabled: card.shuttleEnabled,
    shuttleKind: card.shuttleKind,
    shuttleReviewState: card.shuttleReviewState,
    shuttleSessionId: card.sessionId,
    shuttleAgent: card.shuttleAgent,
    shuttleSchedule: card.shuttleSchedule
      ? { expr: card.shuttleSchedule, tz: card.shuttleTz ?? 'Europe/Paris' }
      : undefined,
  };
}

/** What POST /kanban/transition expects in the body. */
export interface KanbanTransitionRequest {
  fiberId: string;
  target: KanbanTarget;
  card?: KanbanCard;
}

/**
 * What POST /kanban/horizon expects in the body.
 *
 * `horizon: null` clears the top-level `horizon:` key (and `cold`)
 * entirely — the fiber resolves to effectiveHorizon=now by default.
 * `cold` is optional, only meaningful with horizon=stashed; the server
 * writes it when present and clears it when omitted (so dragging a
 * stash→now removes the `cold` line as well).
 *
 * `due` is optional. When present (string or null), it co-writes the
 * top-level `due:` key alongside the surface change — so dragging a
 * card onto a timeline date column writes both `horizon: soon` and
 * `due: <iso>` atomically. Omit `due` to leave the existing `due:`
 * line alone; `due: null` clears it; a string sets it.
 */
export interface KanbanHorizonRequest {
  fiberId: string;
  horizon: KanbanHorizon | null;
  cold?: boolean;
  due?: string | null;
  card?: KanbanCard;
}

/** What POST /kanban/promote-to-shuttle expects in the body. */
export interface KanbanPromoteToShuttleRequest {
  fiberId: string;
  /** Agent id to write into the newly-installed shuttle block. */
  agent: string;
  /** Optional current card snapshot to preserve host-resolution correctness. */
  card?: KanbanCard;
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
  private readonly remoteShuttleDiagnosticsProvider: (() => RemoteShuttleSnapshotDiagnostic[]) | undefined;
  private readonly remoteOriginFilter: string | undefined;
  private readonly remoteFeltHostFilter: string | undefined;
  private readonly includeLocalFibers: boolean;
  private readonly remoteTransitionExecutor:
    | HttpApiKanbanOptions['remoteTransitionExecutor']
    | undefined;
  private readonly temperedLimit: number;
  private readonly listSessions: () => string[];
  private readonly cacheTtlMs: number;
  private readonly shuttleCtlFn: HttpApiKanbanOptions['shuttleCtlFn'];
  private readonly shuttleActionInvokerFn: HttpApiKanbanOptions['shuttleActionInvokerFn'];
  private readonly shuttleActionResolverFn: HttpApiKanbanOptions['shuttleActionResolverFn'];
  private readonly feltEditFn: HttpApiKanbanOptions['feltEditFn'];
  private readonly feltStatusEditFn: HttpApiKanbanOptions['feltStatusEditFn'];

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

    const args = shuttleCtlArgs(invocation.host, invocation.verb, invocation.fiberId);
    if (invocation.verb === 'close' && invocation.tempered !== undefined) {
      args.push(`--tempered=${invocation.tempered ? 'true' : 'false'}`);
    }
    if (invocation.verb === 'install') {
      if (invocation.disabled) args.push('--disabled');
      if (invocation.projectDir) args.push('--project-dir', invocation.projectDir);
      if (invocation.agent) args.push('--model', invocation.agent);
    }
    if (invocation.verb === 'set-outcome') {
      args.push('--outcome', invocation.outcome);
    }
    if (invocation.verb === 'dispatch' && invocation.adHoc) {
      args.push('--ad-hoc');
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
   * Set a fiber's `status:` via `felt edit --status`. Used by the human-card
   * close path in `applyTransition` (no shuttle: block, dragging to
   * tempered/composted means "I'm done with this human todo"). felt owns
   * the native `status:` field, so this stays a thin felt-CLI invocation —
   * no shuttle-ctl involvement, no daemon round-trip.
   */
  private async runFeltStatusEdit(invocation: FeltStatusEditInvocation): Promise<void> {
    if (this.feltStatusEditFn) {
      await this.feltStatusEditFn(invocation);
      return;
    }

    const args = ['-C', invocation.host, 'edit', invocation.fiberId, '--status', invocation.status];

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

  private async invokeShuttleAction(
    request: ShuttleActionInvokeRequest,
    fallbackInvocation: ShuttleCtlInvocation,
  ): Promise<void> {
    if (this.shuttleActionInvokerFn) {
      await this.shuttleActionInvokerFn(request);
      return;
    }
    if (this.shuttleCtlFn) {
      await this.runShuttleCtl(fallbackInvocation);
      return;
    }

    let res: Response;
    try {
      res = await fetch('http://127.0.0.1:4000/api/v1/actions/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiber_id: request.fiberId, action: request.action }),
      });
    } catch {
      // Development fallback: keep kanban usable if the daemon is down. The
      // fallback is still derived from Portolan's target->action mapping; it
      // only shells out locally instead of going through Shuttle's HTTP API.
      await this.runShuttleCtl(fallbackInvocation);
      return;
    }

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json() as { error?: unknown };
        if (typeof body.error === 'string' && body.error.trim()) detail = `: ${body.error.trim()}`;
      } catch {
        // Keep the status-only fallback when the daemon returns non-JSON.
      }
      throw new Error(`Shuttle action invoke returned ${res.status}${detail}`);
    }
  }

  private async resolveShuttleAction(
    request: ShuttleActionResolveRequest,
  ): Promise<ShuttleAction> {
    if (this.shuttleActionResolverFn) {
      return this.shuttleActionResolverFn(request);
    }
    if (this.shuttleCtlFn) {
      return { id: actionForKanbanTarget(request.fiber, request.target) };
    }

    let res: Response;
    try {
      res = await fetch('http://127.0.0.1:4000/api/v1/actions/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiber_id: request.fiberId, target: request.target }),
      });
    } catch {
      // Development fallback: keep kanban usable if the daemon is down. The
      // main path above asks Shuttle for the action id; this fallback is only
      // for local/test operation without a reachable daemon.
      return { id: actionForKanbanTarget(request.fiber, request.target) };
    }

    if (!res.ok) {
      throw new Error(`Shuttle action resolve returned ${res.status}`);
    }

    const body = await res.json() as { action?: unknown };
    if (!body.action || typeof body.action !== 'object' || Array.isArray(body.action)) {
      throw new Error('Shuttle action resolve returned no action');
    }
    const action = body.action as Partial<ShuttleAction>;
    if (!isShuttleActionId(action.id)) {
      throw new Error(`Shuttle action resolve returned unknown action: ${String(action.id)}`);
    }
    return { id: action.id, invocation: action.invocation };
  }

  private async runActionForEntry(
    entry: KanbanFiberEntry,
    target: KanbanTarget,
  ): Promise<void> {
    const ref = canonicalRefForEntry(entry);
    const action = await this.resolveShuttleAction(
      { fiber: entry.fiber, fiberId: ref.fiberId, target },
    );
    await this.invokeShuttleAction(
      { fiber: entry.fiber, fiberId: ref.fiberId, action: action.id },
      invocationForShuttleAction(action, ref),
    );
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
    this.remoteShuttleDiagnosticsProvider = opts.remoteShuttleDiagnosticsProvider;
    this.remoteOriginFilter = opts.remoteOriginFilter;
    this.remoteFeltHostFilter = opts.remoteFeltHostFilter
      ? normalizeRemotePath(opts.remoteFeltHostFilter)
      : undefined;
    this.includeLocalFibers = opts.includeLocalFibers ?? true;
    this.remoteTransitionExecutor = opts.remoteTransitionExecutor;
    this.temperedLimit = opts.temperedLimit ?? 30;
    this.listSessions = opts.listSessions ?? listShuttleSessions;
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
    this.shuttleCtlFn = opts.shuttleCtlFn;
    this.shuttleActionInvokerFn = opts.shuttleActionInvokerFn;
    this.shuttleActionResolverFn = opts.shuttleActionResolverFn;
    this.feltEditFn = opts.feltEditFn;
    this.feltStatusEditFn = opts.feltStatusEditFn;
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

    const hostResults = this.includeLocalFibers
      ? await Promise.all(
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
      )
      : [];

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
        if (!snapshotMatchesRemoteScope(snapshot, this.remoteOriginFilter, this.remoteFeltHostFilter)) {
          continue;
        }
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

      // Kanban-visible fibers: Shuttle-managed cards plus human due-date
      // cards. The column classifier remains unchanged; horizon rows are a
      // second axis computed on each card.
      const kanbanFibers = merged.filter(({ fiber }) => shouldIncludeInKanban(fiber));

      // Probe live shuttle workers — drives the running-worker indicator on
      // in-flight cards, and bumps them to the top of the column.
      const liveSessions = new Set(this.listSessions());

      const ideas: KanbanCard[] = [];
      const drafts: KanbanCard[] = [];
      const scheduled: KanbanCard[] = [];
      const inFlight: KanbanCard[] = [];
      const awaitingReview: KanbanCard[] = [];
      const tempered: KanbanCard[] = [];
      const composted: KanbanCard[] = [];

      const buckets: Record<KanbanColumn, KanbanCard[]> = {
        ideas, drafts, scheduled, inFlight, awaitingReview, tempered, composted,
      };
      for (const { fiber: f, host, originId, canonicalPath } of kanbanFibers) {
        const card = this.toCard(f, host, originId, byId, liveSessions, canonicalPath);
        buckets[classifyFiber(f, { runningWorker: !!card.runningWorker })].push(card);
      }

      // Sort:
      //   ideas           : most-recently-created first (sketches, brainstorms)
      //   drafts          : most-recently-created first (these are works-in-progress)
      //   inFlight        : running workers / status:active first, then by createdAt desc
      //   awaitingReview  : most-recently-closed first
      //   tempered        : most-recently-closed first
      //   composted       : most-recently-closed first (the discarded, in reverse chrono)
      ideas.sort(byCreatedAtDesc);
      scheduled.sort(byCreatedAtDesc);
      // Drafts sort by createdAt desc. Dormant standing roles used to sit
      // at the bottom of this column (waiting for cron, not being actively
      // worked on); they now leave drafts entirely for timeline.futureDated
      // | anytimeSoon, so no dormant-standing tiebreaker is needed.
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

      // Compose the three surfaces from the flat classifier output:
      //   • now      : drafts + inFlight + awaitingReview (open lifecycle)
      //   • timeline : past (closed: tempered + composted), futureDated
      //                (scheduled-with-near-cron OR draft-with-soon+due),
      //                anytimeSoon (scheduled-with-far-cron OR draft-
      //                with-soon-no-due)
      //   • stash    : horizon=stashed (drawn from drafts, since deferred
      //                fibers route to drafts in classifyFiber)
      //
      // Cards may appear in at most one surface. The `scheduled` bucket
      // (dormant standing roles) always routes to timeline at the next
      // cron occurrence. The `drafts` bucket routes by stored horizon.
      // inFlight and awaitingReview always live on now (an enabled+soon
      // fiber would route to drafts, not inFlight, via auto-pause-on-
      // defer).
      const stash: KanbanCard[] = [];
      const futureDated: KanbanCard[] = [];
      const anytimeSoon: KanbanCard[] = [];
      const nowDrafts: KanbanCard[] = [];
      for (const card of scheduled) {
        const launchMs = card.nextLaunchAt ? Date.parse(card.nextLaunchAt) : NaN;
        const withinStrip =
          Number.isFinite(launchMs) &&
          launchMs - Date.now() <= STANDING_TIMELINE_HORIZON_MS;
        if (withinStrip) futureDated.push(card);
        else anytimeSoon.push(card);
      }
      for (const card of drafts) {
        // Drifted cards (due-date within 2 days) live on the desk
        // regardless of stored horizon — the deadline outranks the
        // deferral. Without this branch a stashed-but-imminent card
        // would silently hide in the stash cluster grid.
        if (card.drifted) {
          nowDrafts.push(card);
          continue;
        }
        if (card.storedHorizon === 'stashed') {
          stash.push(card);
        } else if (card.storedHorizon === 'soon') {
          // Bucketed `soon`: either future-dated (renders at a column)
          // or anytime (renders in the pool below the timeline).
          if (card.due) futureDated.push(card);
          else anytimeSoon.push(card);
        } else {
          nowDrafts.push(card);
        }
      }
      // Awaiting-review cards honor the same horizon routing as drafts:
      //   • horizon=stashed       → stash ("I'll judge later, off my desk")
      //   • horizon=soon + due    → timeline.futureDated ("I'll judge on date X")
      //   • horizon=soon, no due  → timeline.anytimeSoon ("I'll judge soon-ish")
      //   • otherwise             → now.awaitingReview (the desk)
      // The future-date case treats "due" as the human's planned review
      // date — judgment is real work the user often has to schedule. The
      // frontend renders closed cards in futureDated with the same
      // gold-dashed "awaiting" treatment as the closedAt ghost so the
      // calendar reads cleanly across past/present/future for these.
      const nowAwaitingReview: KanbanCard[] = [];
      for (const card of awaitingReview) {
        if (card.storedHorizon === 'stashed') {
          stash.push(card);
        } else if (card.storedHorizon === 'soon') {
          if (card.due) futureDated.push(card);
          else anytimeSoon.push(card);
        } else {
          nowAwaitingReview.push(card);
        }
      }

      // The constitution treats `past` as both tempered and composted
      // landings, sorted by closedAt desc. We already sorted each by
      // closedAt; merging preserves the relative ordering inside each
      // verdict bucket and renders consistent across redraws.
      const past = mergeByClosedAtDesc(tempered, composted);

      // futureDated sorts by due date ascending (next deadline first);
      // anytimeSoon stays in createdAt-desc order from the source array.
      futureDated.sort(byDueAtAsc);

      const temperedTotal = tempered.length;

      this.json(res, 200, {
        feltHost: this.feltHost,
        now: {
          drafts: nowDrafts,
          inFlight,
          awaitingReview: nowAwaitingReview,
        },
        timeline: {
          past,
          futureDated,
          anytimeSoon,
        },
        stash,
        ideas,
        totals: {
          ideas: ideas.length,
          drafts: nowDrafts.length,
          // (totals.awaitingReview must match the now-surface partition,
          //  not the classifier output, so stashed awaiting-review cards
          //  don't double-count in the header stats line.)
          inFlight: inFlight.length,
          awaitingReview: nowAwaitingReview.length,
          past: past.length,
          futureDated: futureDated.length,
          anytimeSoon: anytimeSoon.length,
          stash: stash.length,
        },
        temperedTotal,
        staleness: this.buildStaleness(),
        shuttleDiagnostics: this.buildShuttleDiagnostics(),
        remoteScope: this.remoteOriginFilter
          ? {
            originId: this.remoteOriginFilter,
            hostname: this.remoteOriginFilter.replace(/^remote-/, ''),
          }
          : undefined,
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
      const updated = await this.applyTransition(body.fiberId, body.target, body.card);
      this.json(res, 200, { ok: true, card: updated });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[Kanban] transition failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * POST /kanban/dispatch-resume — invoke `shuttle-ctl resume` on a fiber
   * to transition it from awaiting → scheduled-with-next_due_at=now while
   * preserving outcome. Used by the modal's Resume / New Session buttons.
   * The daemon picks up the resulting scheduled role on its next poll, and
   * the latest review-comment (filed by the kanban moments earlier with the
   * user's directive + resume_mode) drives whether the next worker is
   * resumed or fresh.
   *
   * Drag-to-tempered remains accept (advances the cycle, clears outcome).
   * The Resume / New Session buttons are NOT a kind of accept — they're
   * "I'm not done with this run; give me another worker on it" — and that
   * needs a different verb.
   */
  async handleDispatchResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { fiberId?: string };
    try {
      body = await readJsonBody<{ fiberId?: string }>(req);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 400, { error: `bad request body: ${msg}` });
      return;
    }
    if (!body || typeof body.fiberId !== 'string') {
      this.json(res, 400, { error: 'fiberId is required' });
      return;
    }
    const fiberId = body.fiberId;

    try {
      const { merged } = await this.collectFibers();
      const entry = merged.find(({ fiber }) => fiber.id === fiberId);
      if (!entry) throw new Error(`fiber not found: ${fiberId}`);
      const { fiber, host } = entry;
      if (fiber.hasShuttleBlock !== true) {
        throw new Error(
          `kanban only mutates shuttle-managed fibers; ${fiberId} has no shuttle: block`,
        );
      }

      await this.runShuttleCtl({ host, verb: 'resume', fiberId });
      this.clearFiberPoolCache();

      const refreshed = await this.collectFibers();
      const updated = refreshed.merged.find(({ fiber: f }) => f.id === fiberId);
      if (!updated) {
        this.json(res, 200, { ok: true });
        return;
      }
      const liveSessions = new Set(this.listSessions());
      const card = this.toCard(
        updated.fiber,
        updated.host,
        updated.originId,
        new Map(refreshed.merged.map(({ fiber: f }) => [f.id, f])),
        liveSessions,
        updated.canonicalPath,
      );
      this.json(res, 200, { ok: true, card });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[Kanban] dispatch-resume failed:', msg);
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
  async applyTransition(
    fiberId: string,
    target: KanbanTarget,
    card?: KanbanCard,
  ): Promise<KanbanCard> {
    const cardEntry = entryFromLocalCard(card);
    const canUseCardEntry =
      cardEntry !== null &&
      cardEntry.fiber.id === fiberId &&
      target !== 'ideas' &&
      !normalizeTagList(cardEntry.fiber.tags ?? []).includes('idea');

    const pool = canUseCardEntry ? null : await this.collectFibers();
    const entry = cardEntry && canUseCardEntry
      ? cardEntry
      : pool?.merged.find(({ fiber }) => fiber.id === fiberId);
    if (!entry) throw new Error(`fiber not found: ${fiberId}`);
    const { fiber, host, originId } = entry;

    // Human cards (no shuttle: block — pulled in by `shouldIncludeInKanban`'s
    // open/active + due rule) get a thin lifecycle path. There's no daemon
    // to gate, so shuttle-ctl verbs (pause / reopen / dispatch) don't apply.
    // What DOES apply:
    //   • → ideas               : add the `idea` tag (a tag edit, not a
    //                             lifecycle verb — classifyFiber routes
    //                             idea-tagged fibers to the ideas pool).
    //   • → tempered / composted: set `status: closed` via felt edit.
    //                             The human "did" or "dropped" verdict
    //                             reduces to a status close for non-shuttle
    //                             fibers; `shouldIncludeInKanban` then
    //                             excludes the card on the next render
    //                             (closed human cards drop off the board).
    // Other targets (drafts / inFlight / awaitingReview) have no meaning
    // for a card with no shuttle contract — reject with a clear message
    // rather than silently no-op.
    if (fiber.hasShuttleBlock !== true) {
      if (originId !== 'local') {
        throw new Error(
          `remote human-card transitions are not yet supported ` +
            `(fiber ${fiberId} is on origin '${originId}'). ` +
            `Close it via felt edit on the host directly, or add a shuttle: block.`,
        );
      }
      const currentTags = normalizeTagList(fiber.tags ?? []);
      if (target === 'ideas') {
        if (currentTags.includes('idea')) return this.applyTags(fiberId, currentTags);
        return this.applyTags(fiberId, [...currentTags, 'idea']);
      }
      if (target === 'tempered' || target === 'composted') {
        await this.runFeltStatusEdit({ host, fiberId, status: 'closed' });
        this.clearFiberPoolCache();
        const refreshed = await getFiber(host, fiberId);
        if (!refreshed) {
          throw new Error(`failed to refresh fiber through felt show: ${fiberId}`);
        }
        return this.toCard(refreshed, host, originId, new Map([[fiberId, refreshed]]));
      }
      throw new Error(
        `human cards (no shuttle: block) only support ideas / tempered / composted ` +
          `transitions; got target '${target}' for fiber ${fiberId}`,
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
      // the fiber first, then pause it back into a non-dispatchable draft,
      // then add the `idea` tag so classification places it into Ideas
      // (the `idea` tag takes precedence for open fibers). Shuttle only
      // exposes `reopen` for closed fibers, so asking it to `pause` the
      // closed fiber directly returns action_not_available.
      if (fiber.status === 'closed') {
        if (originId !== 'local') {
          if (!this.remoteTransitionExecutor) {
            throw new Error(
              `remote-origin transitions require remoteTransitionExecutor wiring ` +
                `(fiber ${fiberId} is on origin '${originId}')`,
            );
          }
          await this.remoteTransitionExecutor({
            originId,
            feltHost: host,
            path: relativeFeltPath(fiber),
            kind: 'shuttle',
            ...transitionInvocationForTarget(fiber, { host, fiberId: fiber.id }, 'inFlight'),
          });
          await this.remoteTransitionExecutor({
            originId,
            feltHost: host,
            path: relativeFeltPath(fiber),
            kind: 'shuttle',
            ...transitionInvocationForTarget(fiber, { host, fiberId: fiber.id }, 'drafts'),
          });
          this.clearFiberPoolCache();
        } else {
          await this.runActionForEntry(entry, 'inFlight');
          this.clearFiberPoolCache();
          await this.runActionForEntry(entry, 'drafts');
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
        feltHost: host,
        path: relativeFeltPath(fiber),
        kind: 'shuttle',
        ...transitionInvocationForTarget(fiber, { host, fiberId: fiber.id }, target),
      });
      this.clearFiberPoolCache();
      const refreshedById = new Map<string, Fiber>();
      if (this.remoteSnapshotsProvider) {
        for (const snap of this.remoteSnapshotsProvider()) {
          if (snap.originId !== originId || normalizeRemotePath(snap.feltHost) !== normalizeRemotePath(host)) continue;
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

    await this.runActionForEntry(entry, target);
    this.clearFiberPoolCache();

    const refreshed = await getFiber(host, fiberId);
    if (!refreshed) throw new Error(`failed to refresh fiber through felt show: ${fiberId}`);
    const refreshedById = new Map(pool?.merged.map(({ fiber: f }) => [f.id, f]) ?? []);
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
        feltHost: host,
        fiberId,
        path: relativeFeltPath(fiber),
        kind: 'felt-tags',
        tags: normalized,
      });
      this.clearFiberPoolCache();
      const refreshedById = new Map<string, Fiber>();
      if (this.remoteSnapshotsProvider) {
        for (const snap of this.remoteSnapshotsProvider()) {
          if (snap.originId !== originId || normalizeRemotePath(snap.feltHost) !== normalizeRemotePath(host)) continue;
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
   * POST /kanban/promote-to-shuttle — install a paused one-shot shuttle
   * block on a human card (a visible fiber with no existing shuttle block).
   *
   * Body: { fiberId, agent, card? }
   *
   * Promotion routes through `shuttle-ctl install --disabled` rather than a
   * bespoke frontmatter writer: the CLI already validates the agent id and
   * preserves unrelated frontmatter bytes while appending the `shuttle:`
   * block. The newly-promoted card lands in Drafts (`enabled: false`) until
   * the human drags it into In Flight or resumes it from the modal.
   */
  async handlePromoteToShuttle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: KanbanPromoteToShuttleRequest;
    try {
      body = await readJsonBody<KanbanPromoteToShuttleRequest>(req);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 400, { error: `bad request body: ${msg}` });
      return;
    }
    if (!body || typeof body.fiberId !== 'string' || typeof body.agent !== 'string') {
      this.json(res, 400, { error: 'fiberId and agent are required' });
      return;
    }

    try {
      const updated = await this.applyPromoteToShuttle(
        body.fiberId,
        body.agent.trim(),
        body.card,
      );
      this.json(res, 200, { ok: true, card: updated });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      const status =
        msg.startsWith('fiber not found:') ? 404
        : msg.includes('agent is required') ||
            msg.includes('already has a shuttle: block') ||
            msg.includes('kanban only promotes visible human cards')
          ? 400
          : 500;
      console.error('[Kanban] promote-to-shuttle failed:', msg);
      this.json(res, status, { error: msg });
    }
  }

  async applyPromoteToShuttle(
    fiberId: string,
    agent: string,
    card?: KanbanCard,
  ): Promise<KanbanCard> {
    if (!agent) throw new Error('agent is required');

    const cardEntry = entryFromLocalCard(card);
    const canUseCardEntry =
      cardEntry !== null &&
      cardEntry.fiber.id === fiberId &&
      cardEntry.fiber.hasShuttleBlock !== true;

    const pool = canUseCardEntry ? null : await this.collectFibers();
    const entry = canUseCardEntry
      ? cardEntry
      : pool?.merged.find(({ fiber }) => fiber.id === fiberId);
    if (!entry) throw new Error(`fiber not found: ${fiberId}`);
    const { fiber, host, originId } = entry;

    if (!shouldIncludeInKanban(fiber) || fiber.hasShuttleBlock === true) {
      if (fiber.hasShuttleBlock === true) {
        throw new Error(
          `fiber ${fiberId} already has a shuttle: block; use kanban transitions instead`,
        );
      }
      throw new Error(
        `kanban only promotes visible human cards; ${fiberId} is not currently a human card`,
      );
    }

    if (originId !== 'local') {
      if (!this.remoteTransitionExecutor) {
        throw new Error(
          `remote-origin promotion requires remoteTransitionExecutor wiring ` +
            `(fiber ${fiberId} is on origin '${originId}')`,
        );
      }
      await this.remoteTransitionExecutor({
        originId,
        feltHost: host,
        host,
        fiberId,
        path: relativeFeltPath(fiber),
        kind: 'shuttle',
        verb: 'install',
        agent,
        disabled: true,
      });
      this.clearFiberPoolCache();
      const refreshedById = new Map<string, Fiber>();
      if (this.remoteSnapshotsProvider) {
        for (const snap of this.remoteSnapshotsProvider()) {
          if (snap.originId !== originId || normalizeRemotePath(snap.feltHost) !== normalizeRemotePath(host)) continue;
          for (const f of snap.fibers) refreshedById.set(f.id, f);
        }
      }
      const refreshed = refreshedById.get(fiberId);
      if (!refreshed) throw new Error(`remote fiber disappeared: ${fiberId}`);
      return this.toCard(refreshed, host, originId, refreshedById);
    }

    const ref = canonicalRefForEntry(entry);
    await this.runShuttleCtl({
      host: ref.host,
      verb: 'install',
      fiberId: ref.fiberId,
      agent,
      disabled: true,
    });
    this.clearFiberPoolCache();

    const refreshed = await getFiber(host, fiberId);
    if (!refreshed) throw new Error(`failed to refresh fiber through felt show: ${fiberId}`);
    const refreshedById = new Map(pool?.merged.map(({ fiber: f }) => [f.id, f]) ?? []);
    refreshedById.set(fiberId, refreshed);
    let canonicalAfter: string | undefined;
    try {
      canonicalAfter = realpathSync(this.fiberPath(host, refreshed));
    } catch {
      canonicalAfter = undefined;
    }
    return this.toCard(refreshed, host, originId, refreshedById, undefined, canonicalAfter);
  }

  /**
   * POST /kanban/horizon — set or clear a card's top-level `horizon:`
   * (and optional `cold:`) frontmatter keys. Horizon is a Portolan-owned
   * surface-routing axis, not a Shuttle lifecycle field, so local writes
   * edit the fiber file directly and remote writes route through the
   * existing agent mutation channel.
   *
   * Body: { fiberId, horizon: 'now'|'soon'|'stashed'|null, cold?: boolean, card? }
   *
   * `horizon: null` clears both `horizon` and `cold` (card returns to
   * default Now placement). The legacy values 'later' and 'someday' are
   * rejected with 400 — the migration script
   * (scripts/migrate-kanban-horizon-three-surface.ts) rewrites those
   * before the new code reads them.
   */
  async handleHorizon(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: KanbanHorizonRequest;
    try {
      body = await readJsonBody<KanbanHorizonRequest>(req);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.json(res, 400, { error: `bad request body: ${msg}` });
      return;
    }
    if (!body || typeof body.fiberId !== 'string' || !('horizon' in body)) {
      this.json(res, 400, { error: 'fiberId and horizon are required' });
      return;
    }
    if (body.horizon !== null) {
      if (typeof body.horizon === 'string' && LEGACY_HORIZONS.has(body.horizon)) {
        this.json(res, 400, {
          error: `legacy horizon "${body.horizon}" is no longer supported; ` +
            `run scripts/migrate-kanban-horizon-three-surface.ts and use ` +
            `'stashed' (with cold: true for the held-open case)`,
        });
        return;
      }
      if (!HORIZON_SET.has(body.horizon)) {
        this.json(res, 400, { error: `unknown horizon: ${String(body.horizon)}` });
        return;
      }
    }
    if (body.cold !== undefined && typeof body.cold !== 'boolean') {
      this.json(res, 400, { error: 'cold must be a boolean when present' });
      return;
    }
    if (body.due !== undefined && body.due !== null && typeof body.due !== 'string') {
      this.json(res, 400, { error: 'due must be a string or null when present' });
      return;
    }

    try {
      const updated = await this.applyHorizon(
        body.fiberId,
        body.horizon,
        body.cold,
        body.due,
        body.card,
      );
      this.json(res, 200, { ok: true, card: updated });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[Kanban] horizon edit failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  async applyHorizon(
    fiberId: string,
    horizon: KanbanHorizon | null,
    cold?: boolean,
    due?: string | null,
    card?: KanbanCard,
  ): Promise<KanbanCard> {
    const cardEntry = entryFromLocalCard(card);
    const canUseCardEntry = cardEntry !== null && cardEntry.fiber.id === fiberId;
    const pool = canUseCardEntry ? null : await this.collectFibers();
    const entry = canUseCardEntry
      ? cardEntry
      : pool?.merged.find(({ fiber }) => fiber.id === fiberId);
    if (!entry) throw new Error(`fiber not found: ${fiberId}`);
    const { fiber, host, originId } = entry;
    if (!shouldIncludeInKanban(fiber)) {
      throw new Error(`kanban only mutates visible fibers; ${fiberId} is not on the board`);
    }

    if (originId !== 'local') {
      if (!this.remoteTransitionExecutor) {
        throw new Error(
          `remote-origin horizon edits require remoteTransitionExecutor wiring ` +
            `(fiber ${fiberId} is on origin '${originId}')`,
        );
      }
      await this.remoteTransitionExecutor({
        originId,
        feltHost: host,
        fiberId,
        path: relativeFeltPath(fiber),
        kind: 'felt-horizon',
        horizon,
        cold,
        due,
      });
      this.clearFiberPoolCache();
      const refreshedById = new Map<string, Fiber>();
      if (this.remoteSnapshotsProvider) {
        for (const snap of this.remoteSnapshotsProvider()) {
          if (snap.originId !== originId || normalizeRemotePath(snap.feltHost) !== normalizeRemotePath(host)) continue;
          for (const f of snap.fibers) refreshedById.set(f.id, f);
        }
      }
      const refreshed = refreshedById.get(fiberId);
      if (!refreshed) throw new Error(`remote fiber disappeared: ${fiberId}`);
      return this.toCard(refreshed, host, originId, refreshedById);
    }

    const path = this.fiberPath(host, fiber);
    if (!existsSync(path)) throw new Error(`fiber file missing: ${path}`);
    const raw = await readFile(path, 'utf-8');
    await writeFile(path, rewriteHorizonFrontmatter(raw, horizon, cold, due), 'utf-8');
    this.clearFiberPoolCache();

    const refreshed = await getFiber(host, fiberId);
    if (!refreshed) throw new Error(`failed to refresh fiber through felt show: ${fiberId}`);
    const refreshedById = new Map(pool?.merged.map(({ fiber: f }) => [f.id, f]) ?? []);
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

    let entry: KanbanFiberEntry;
    let ref: { host: string; fiberId: string };
    try {
      const { merged } = await this.collectFibers();
      const found = merged.find(({ fiber }) => fiber.id === body.fiberId);
      if (!found) {
        this.json(res, 404, { error: `fiber not found: ${body.fiberId}` });
        return;
      }
      entry = found;
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
      const historyFields = {
        resume_mode: body.resumeMode,
        ...(interactive ? { interactive: 'true' } : {}),
      };
      if (entry.originId !== 'local') {
        if (!this.remoteTransitionExecutor) {
          throw new Error(
            `remote-origin review comments require remoteTransitionExecutor wiring ` +
              `(fiber ${body.fiberId} is on origin '${entry.originId}')`,
          );
        }
        await this.remoteTransitionExecutor({
          originId: entry.originId,
          feltHost: ref.host,
          kind: 'felt-history',
          path: relativeFeltPath(entry.fiber),
          fiberId: ref.fiberId,
          historyKind: 'review-comment',
          summary: directive,
          historyFields,
        });
        this.json(res, 200, { ok: true });
        return;
      }
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
            feltHost: host,
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
          await execFileAsync('shuttle-ctl', shuttleCtlArgs(localRef.host, 'uninstall', localRef.fiberId), ctlEnv);
        }

        if (targetKind === 'standing') {
          const args = [
            ...shuttleCtlArgs(localRef.host, 'repeat', localRef.fiberId),
            '--schedule', targetSchedule!,
            '--tz', targetTz!,
          ];
          if (targetAgent) args.push('--model', targetAgent);
          await execFileAsync('shuttle-ctl', args, ctlEnv);
        } else {
          const args = shuttleCtlArgs(localRef.host, 'install', localRef.fiberId);
          if (targetAgent) args.push('--model', targetAgent);
          if (wasDisabled) args.push('--disabled');
          await execFileAsync('shuttle-ctl', args, ctlEnv);
        }
      } else if (typeof body.shuttleAgent === 'string' && body.shuttleAgent) {
        // Agent-only change → set-model preserves session.id and review state.
        await execFileAsync('shuttle-ctl', [
          ...shuttleCtlArgs(localRef.host, 'set-model', localRef.fiberId),
          body.shuttleAgent,
        ], {
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
    const horizon = effectiveHorizon(f);

    // Resolve which pinned local city physically owns this fiber so the
    // frontend can pivot vellum to that city and navigate to the project-
    // relative slug. Loom-relative ids (`ai-futures/portolan/vellum-reader/X`)
    // don't match anything in a project-scoped fiber graph; the kanban-side
    // canonical-path realpath gets us back to the project-rooted view.
    let cityId: string | undefined;
    let projectSlug: string | undefined;
    let shuttleFiberId: string | undefined;
    if (canonicalPath !== undefined) {
      shuttleFiberId = canonicalFiberRefFromPath(canonicalPath)?.fiberId;
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
      due: f.due,
      tags: f.tags,
      createdAt: f.createdAt,
      closedAt: f.closedAt,
      tempered: f.tempered,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      dependsOnSatisfied,
      runningWorker,
      cityId,
      projectSlug,
      shuttleFiberId,
      sessionId: f.shuttleSessionId,
      shuttleEnabled: f.shuttleEnabled,
      shuttleAgent: f.shuttleAgent,
      shuttleKind: f.shuttleKind,
      shuttleSchedule: f.shuttleSchedule?.expr,
      shuttleTz: f.shuttleSchedule?.tz,
      shuttleReviewState: f.shuttleReviewState,
      nextLaunchAt: nextStandingLaunch(f),
      storedHorizon: horizon.storedHorizon,
      effectiveHorizon: horizon.effectiveHorizon,
      drifted: horizon.drifted,
      cold: typeof f.cold === 'boolean' ? f.cold : undefined,
    };
  }

  private emptyResponse(): KanbanResponse {
    return {
      feltHost: this.feltHost,
      now: { drafts: [], inFlight: [], awaitingReview: [] },
      timeline: { past: [], futureDated: [], anytimeSoon: [] },
      stash: [],
      ideas: [],
      totals: {
        ideas: 0, drafts: 0, inFlight: 0, awaitingReview: 0,
        past: 0, futureDated: 0, anytimeSoon: 0, stash: 0,
      },
      temperedTotal: 0,
      staleness: this.buildStaleness(),
      shuttleDiagnostics: this.buildShuttleDiagnostics(),
      remoteScope: this.remoteOriginFilter
        ? {
          originId: this.remoteOriginFilter,
          hostname: this.remoteOriginFilter.replace(/^remote-/, ''),
        }
        : undefined,
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
      if (!snapshotMatchesRemoteScope(snap, this.remoteOriginFilter, this.remoteFeltHostFilter)) {
        continue;
      }
      const hostname = snap.originId.replace(/^remote-/, '');
      out[snap.originId] = {
        status: snap.status,
        hostname,
        staleSince: snap.staleSince,
      };
    }
    if (this.remoteOriginFilter && !out[this.remoteOriginFilter]) {
      out[this.remoteOriginFilter] = {
        status: 'stale',
        hostname: this.remoteOriginFilter.replace(/^remote-/, ''),
      };
    }
    return out;
  }

  private buildShuttleDiagnostics(): KanbanResponse['shuttleDiagnostics'] {
    const all = this.remoteShuttleDiagnosticsProvider?.() ?? [];
    const filtered = this.remoteOriginFilter
      ? all.filter((entry) => entry.originId === this.remoteOriginFilter)
      : all;
    return { remoteSnapshots: filtered };
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

function normalizeRemotePath(path: string): string {
  return path.replace(/\/+$/, '');
}

function shuttleCtlArgs(host: string, verb: string, fiberId: string): string[] {
  return ['--felt-store', host, verb, fiberId];
}

function snapshotMatchesRemoteScope(
  snapshot: FiberTreeSnapshot,
  originId: string | undefined,
  feltHost: string | undefined,
): boolean {
  if (originId && snapshot.originId !== originId) return false;
  if (feltHost && normalizeRemotePath(snapshot.feltHost) !== feltHost) return false;
  return true;
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

/** Ascending sort by next-occurrence-or-due (earliest deadline first).
 *  Standing roles use `nextLaunchAt` (cron-derived), human due-date cards
 *  use `due`; both are ISO timestamps so string compare is order-correct.
 *  Cards with neither sort last. */
function byDueAtAsc(a: KanbanCard, b: KanbanCard): number {
  const aT = a.nextLaunchAt ?? a.due ?? '';
  const bT = b.nextLaunchAt ?? b.due ?? '';
  if (aT === bT) return 0;
  if (!aT) return 1;
  if (!bT) return -1;
  return aT.localeCompare(bT);
}

/** Merge two pre-sorted-by-closedAt-desc arrays preserving the global
 *  ordering. The two inputs are already sorted; we interleave by
 *  comparing heads. Avoids the O(n log n) penalty of resorting the
 *  concatenation when both inputs come straight from sort calls above. */
function mergeByClosedAtDesc(a: KanbanCard[], b: KanbanCard[]): KanbanCard[] {
  const out: KanbanCard[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (byClosedAtDesc(a[i], b[j]) <= 0) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
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
  return invocationForShuttleAction({ id: actionForKanbanTarget(fiber, target) }, ref);
}

function actionForKanbanTarget(fiber: Fiber, target: KanbanTarget): ShuttleActionId {
  const isInFlightTarget =
    target === 'inFlight' || target === 'queued' || target === 'active';

  if (fiber.status === 'closed' && isInFlightTarget) return 'reopen';

  // Drag a standing role in awaiting state to inFlight (or tempered) =
  // accept the pending run cyclically. Card returns to drafts (sorted to
  // bottom) until the next cron tick.
  const isStandingAccept =
    (isInFlightTarget || target === 'tempered') &&
    fiber.shuttleKind === 'standing' &&
    fiber.shuttleReviewState === 'awaiting';

  if (isStandingAccept) return 'accept-run';
  if (target === 'drafts') return 'pause';

  // Drag a dormant standing role (scheduled/accepted, enabled) to inFlight
  // = manual ad-hoc dispatch. Generates a synthetic adhoc-* run id; does
  // not advance next_due_at, so the cron schedule keeps its rhythm. Paused
  // (enabled=false) standing roles still take the reopen path; resume
  // them first if you want to fire one now.
  if (
    isInFlightTarget &&
    fiber.shuttleKind === 'standing' &&
    fiber.shuttleEnabled !== false &&
    (fiber.shuttleReviewState === 'scheduled' || fiber.shuttleReviewState === 'accepted')
  ) {
    return 'dispatch-ad-hoc';
  }

  if (isInFlightTarget) {
    return 'reopen';
  }
  if (target === 'awaitingReview') return 'close-awaiting-review';
  if (target === 'tempered') return 'close-tempered';
  return 'close-composted';
}

function invocationForShuttleAction(
  action: ShuttleAction,
  ref: { host: string; fiberId: string },
): ShuttleCtlInvocation {
  switch (action.id) {
    case 'pause':
      return { host: ref.host, verb: 'pause', fiberId: ref.fiberId };
    case 'reopen':
      return { host: ref.host, verb: 'reopen', fiberId: ref.fiberId };
    case 'accept-run':
      return { host: ref.host, verb: 'accept', fiberId: ref.fiberId };
    case 'dispatch-ad-hoc':
      return { host: ref.host, verb: 'dispatch', fiberId: ref.fiberId, adHoc: true };
    case 'close-awaiting-review':
      return { host: ref.host, verb: 'close', fiberId: ref.fiberId };
    case 'close-tempered':
      return { host: ref.host, verb: 'close', fiberId: ref.fiberId, tempered: true };
    case 'close-composted':
      return { host: ref.host, verb: 'close', fiberId: ref.fiberId, tempered: false };
    case 'continue-run-fresh':
    case 'continue-run-previous':
      return { host: ref.host, verb: 'resume', fiberId: ref.fiberId };
  }
}

function isShuttleActionId(value: unknown): value is ShuttleActionId {
  return (
    value === 'pause' ||
    value === 'reopen' ||
    value === 'accept-run' ||
    value === 'continue-run-fresh' ||
    value === 'continue-run-previous' ||
    value === 'dispatch-ad-hoc' ||
    value === 'close-awaiting-review' ||
    value === 'close-tempered' ||
    value === 'close-composted'
  );
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

/**
 * Rewrite the top-level `horizon:`, `cold:`, and `due:` keys in a
 * fiber file's YAML frontmatter. Preserves unrelated lines byte-for-
 * byte (we only edit the matched ranges).
 *
 * Semantics:
 *   horizon=null            → remove `horizon:` and `cold:` entirely.
 *   horizon='now'|'soon'    → write `horizon:`; remove `cold:` (a non-
 *                             stashed card has no `cold` meaning).
 *   horizon='stashed'       → write `horizon:`; thread cold through:
 *     cold === undefined    → leave existing `cold:` line alone.
 *     cold === true         → write `cold: true`.
 *     cold === false        → remove `cold:` (default warm).
 *
 *   due === undefined       → leave existing `due:` line alone.
 *   due === null            → remove `due:`.
 *   due === '2026-…'        → write `due: <value>`.
 */
function rewriteHorizonFrontmatter(
  raw: string,
  horizon: KanbanHorizon | null,
  cold?: boolean,
  due?: string | null,
): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
  if (!match) throw new Error('fiber file has no YAML frontmatter');

  const frontmatter = match[1];
  const parsed = YAML.parse(frontmatter) as unknown;
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('fiber frontmatter must be a YAML mapping');
  }

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const closingNewline = match[2] ?? '';
  const body = raw.slice(match[0].length);
  const lines = frontmatter.length > 0 ? frontmatter.split(/\r?\n/) : [];

  // Rewrite `horizon:` first; rewriteOrRemove keeps lines indices coherent
  // because it always splices in-place.
  rewriteOrRemoveKey(lines, 'horizon', horizon === null ? null : `horizon: ${horizon}`);

  // Resolve cold: nullable horizon and non-stashed horizon both imply
  // clearing cold; for stashed we honor the explicit `cold` argument.
  let nextColdLine: string | null = null;
  let touchCold = true;
  if (horizon === null) {
    nextColdLine = null;
  } else if (horizon !== 'stashed') {
    nextColdLine = null;
  } else if (cold === undefined) {
    touchCold = false; // leave existing line alone
  } else if (cold === true) {
    nextColdLine = 'cold: true';
  } else {
    nextColdLine = null; // explicit false → remove
  }
  if (touchCold) rewriteOrRemoveKey(lines, 'cold', nextColdLine);

  // `due` rewrite: omit → no touch; null → clear; string → write.
  if (due !== undefined) {
    rewriteOrRemoveKey(lines, 'due', due === null ? null : `due: ${due}`);
  }

  return `---${eol}${lines.join(eol)}${eol}---${closingNewline}${body}`;
}

/** In-place edit: when `replacement` is non-null, set the key's range to
 *  that single line; when null, splice the existing range out entirely.
 *  When `replacement` is non-null and the key is absent, append at the
 *  end of the frontmatter. */
function rewriteOrRemoveKey(
  lines: string[],
  key: string,
  replacement: string | null,
): void {
  const range = topLevelKeyRange(lines, key);
  if (replacement === null) {
    if (range) lines.splice(range.start, range.end - range.start);
    return;
  }
  if (range) {
    lines.splice(range.start, range.end - range.start, replacement);
  } else {
    lines.push(replacement);
  }
}

function topLevelKeyRange(
  lines: string[],
  key: string,
): { start: number; end: number } | null {
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:`);
  const topLevelKeyRe = /^[A-Za-z0-9_-]+\s*:/;
  const start = lines.findIndex((line) => keyRe.test(line));
  if (start === -1) return null;

  let end = start + 1;
  while (end < lines.length && !topLevelKeyRe.test(lines[end])) end += 1;
  return { start, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
