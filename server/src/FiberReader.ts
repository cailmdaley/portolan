import { join } from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface Fiber {
  id: string;        // slug path under .felt/ — bare for top-level (`foo`) or
                     // slash-joined for nested (`foo/bar`). Matches what
                     // `felt ls --json` emits for nested fibers.
  name: string;      // frontmatter `name:` (ASTRA vocabulary)
  status: string;    // open, active, closed
  kind: string;      // task, decision, question, spec
  priority: number;  // default 2
  createdAt: string; // ISO date from frontmatter
  body?: string;     // markdown body after frontmatter
  outcome?: string;  // outcome from frontmatter
  closedAt?: string; // ISO date from frontmatter
  due?: string;       // project-owned frontmatter `due:` for human-facing deadlines
  horizon?: string;   // project-owned frontmatter `horizon:` — `now | soon | stashed`
                      // (legacy `later`/`someday` migrated by scripts/migrate-
                      // kanban-horizon-three-surface.ts; the kanban classifier
                      // narrows unknown values to `now`).
  cold?: boolean;     // project-owned frontmatter `cold:` — when true, stash
                      // cluster renders dimmer and below warm clusters
                      // (held-open). Default false (warm).
  tags?: string[];   // e.g. ["tapestry:cosebis_data_vector"]
  dependsOn?: string[]; // fiber IDs this depends on
  tempered?: boolean;   // human-acceptance signal — agent never sets this itself; Shuttle reads it as the dependency-satisfied edge
  /** True when the fiber has a `shuttle:` frontmatter block. The dispatch signal lives here. */
  hasShuttleBlock?: boolean;
  /**
   * Whether shuttle dispatch is enabled for this fiber (`shuttle.enabled`).
   * Present only when `hasShuttleBlock` is true. `false` means the fiber is
   * in the drafts column (installed but paused); `true` means in-flight
   * (eligible for dispatch). Absence means the fiber has no shuttle block.
   */
  shuttleEnabled?: boolean;
  /**
   * `shuttle.kind` — `oneshot` (default) or `standing`. Standing roles have
   * a richer lifecycle (cron schedule + per-run review state). Drives column
   * placement and transition semantics: a standing role's review acceptance
   * is `shuttle-ctl accept`, not the oneshot resume+reopen dance.
   */
  shuttleKind?: 'oneshot' | 'standing';
  /**
   * `shuttle.review.state` for standing roles — canonical persisted values
   * are `scheduled` | `awaiting` | `accepted`. Runtime-only states such as
   * `running` and `due` come from live worker/snapshot data, not frontmatter.
   * `awaiting` after a worker completes a run; the kanban routes the card to
   * the awaitingReview column even though `status` remains `active`. Cleared
   * (back to `scheduled`) by `shuttle-ctl accept`.
   */
  shuttleReviewState?: 'scheduled' | 'awaiting' | 'accepted';
  /**
   * `shuttle.session.id` — the session UUID of the most recently dispatched
   * worker when the frontmatter still carries one. Kanban treats this as
   * display-only hint data; Shuttle owns resume resolution at dispatch time.
   */
  shuttleSessionId?: string;
  /**
   * `shuttle.agent` — the agent identifier to dispatch with (e.g. `claude-opus`).
   * Present only when `hasShuttleBlock` is true. Absent when the shuttle block
   * doesn't specify an agent (daemon uses its default).
   */
  shuttleAgent?: string;
  /**
   * `shuttle.schedule` — cron expression + IANA timezone for standing roles.
   * Present only when `hasShuttleBlock` is true and `kind === 'standing'`.
   * Read by the kanban fiber-detail modal so the human can tune the cadence
   * without dropping into vellum.
   */
  shuttleSchedule?: { expr: string; tz: string };
  parentId?: string | null; // parent fiber id (derived from slug path); null for top-level
  isRoot?: boolean;  // entry-point fiber: bare `.felt/<slug>.md` (appears via loom symlink)
}

// ── Internal ───────────────────────────────────────────────────────

/**
 * Read and parse all fibers in a city's .felt/ directory by shelling out
 * to `felt -C <city> ls -s all -j` (with `--body` when bodies are needed).
 *
 * Why felt-mediated rather than disk-walking: felt emits the full
 * frontmatter (including tool-owned namespaces like `shuttle:`) as flat
 * top-level JSON keys, so consumers don't reimplement felt's parsing.
 * The rule we enforce: **felt owns reading; tools own write/orchestration.**
 *
 * `withBody` is opt-in. Bodies inflate the JSON payload ~80× (8.6 MB vs
 * ~100 KB on a 325-fiber loom) and force felt to read every file's body
 * off disk; metadata-only callers (kanban, fiber-count probes) should
 * keep the default `false`. Search/tapestry callers that score against
 * body content pass `true`.
 */
async function readAllFibers(cityPath: string, opts: { withBody?: boolean } = {}): Promise<Fiber[]> {
  const feltPath = join(cityPath, '.felt');

  if (!existsSync(feltPath)) {
    return [];
  }

  const args = ['-C', cityPath, 'ls', '-s', 'all', '-j'];
  if (opts.withBody) args.push('--body');

  let stdout: string;
  try {
    const result = await execFileAsync(
      'felt',
      args,
      // Body-bearing payloads on a multi-thousand-fiber store can run into
      // double-digit MBs; allow 64MB for headroom even though metadata-only
      // calls stay under 1MB.
      { maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    console.warn(`felt ls failed for ${feltPath}:`, err);
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    console.warn(`Failed to parse felt ls JSON for ${feltPath}:`, err);
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }

  const fibers: Fiber[] = [];
  for (const item of raw) {
    const fiber = mapFeltJsonToFiber(item);
    if (fiber) fibers.push(fiber);
  }
  return fibers;
}

/**
 * Map one entry from felt's JSON output onto the Portolan Fiber interface.
 * Tool-owned namespaces (`shuttle:`, `tempered:`, `depends_on:`) arrive as
 * native JSON values (felt v1.0.4+) so we read them directly rather than
 * re-parsing YAML.
 *
 * `kind` and `priority` are not part of felt's serialized model — they're
 * Portolan/ASTRA conventions felt does not interpret. We default them so
 * downstream consumers see a uniform shape regardless of source.
 */
export function mapFeltJsonToFiber(item: unknown): Fiber | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const f = item as Record<string, unknown>;

  const id = typeof f.id === 'string' ? f.id : '';
  if (!id) return null;

  const status = typeof f.status === 'string' ? f.status : '';
  const name = typeof f.name === 'string' && f.name ? f.name : id;
  const outcome = typeof f.outcome === 'string' ? f.outcome : undefined;
  const body = typeof f.body === 'string' ? f.body : undefined;
  const due = typeof f.due === 'string' && f.due.trim() ? f.due.trim() : undefined;
  const horizon = typeof f.horizon === 'string' && f.horizon.trim() ? f.horizon.trim() : undefined;
  const cold = typeof f.cold === 'boolean' ? f.cold : undefined;

  // Prefer canonical *_at fields; fall back to legacy `created`/`closed`
  // for older fibers that haven't been migrated.
  const createdAt = pickIsoString(f, ['created_at', 'created']) ?? '';
  const closedAt = pickIsoString(f, ['closed_at', 'closed']);

  const tags = stringList(f.tags);
  // depends_on ships from felt as `[{id: "..."}]` for fibers using
  // wikilink-style references (the common case post 2026-04 cleanup),
  // and as bare-string arrays for legacy / hand-edited fibers. Accept
  // both shapes — `stringList` alone silently drops the object form.
  // See [[ai-futures/portolan/gotchas/gotcha-fiber-reader-depends-on-object-shape]].
  const dependsOn =
    fiberRefList(f.depends_on) ?? fiberRefList(f['depends-on']);

  const tempered = typeof f.tempered === 'boolean' ? f.tempered : undefined;

  // shuttle: arrives as a native JSON map post felt v1.0.4. Anything else
  // (string, array, missing) means no shuttle block.
  const shuttleRaw = f.shuttle;
  const hasShuttleBlock =
    !!shuttleRaw && typeof shuttleRaw === 'object' && !Array.isArray(shuttleRaw);

  let shuttleEnabled: boolean | undefined;
  let shuttleKind: 'oneshot' | 'standing' | undefined;
  let shuttleReviewState: 'scheduled' | 'awaiting' | 'accepted' | undefined;
  let shuttleSessionId: string | undefined;
  let shuttleAgent: string | undefined;
  let shuttleSchedule: { expr: string; tz: string } | undefined;

  if (hasShuttleBlock) {
    const s = shuttleRaw as Record<string, unknown>;
    shuttleEnabled = s.enabled === false ? false : true;
    shuttleKind = s.kind === 'standing' ? 'standing' : 'oneshot';

    const review = s.review;
    if (review && typeof review === 'object' && !Array.isArray(review)) {
      const state = (review as Record<string, unknown>).state;
      if (state === 'scheduled' || state === 'awaiting' || state === 'accepted') {
        shuttleReviewState = state;
      }
    }

    const session = s.session;
    if (session && typeof session === 'object' && !Array.isArray(session)) {
      const sid = (session as Record<string, unknown>).id;
      if (typeof sid === 'string' && sid) shuttleSessionId = sid;
    }

    if (typeof s.agent === 'string' && s.agent) shuttleAgent = s.agent;

    // shuttle.schedule = { expr, tz } for standing roles. Pre-CLI fibers may
    // carry the legacy `timezone` key; the daemon reads either, so we mirror
    // both here for backward-compat. Absent fields fall back to UTC for tz.
    const sched = s.schedule;
    if (sched && typeof sched === 'object' && !Array.isArray(sched)) {
      const m = sched as Record<string, unknown>;
      const expr = typeof m.expr === 'string' ? m.expr.trim() : '';
      const tzRaw = typeof m.tz === 'string'
        ? m.tz
        : typeof m.timezone === 'string'
          ? m.timezone
          : '';
      const tz = tzRaw.trim() || 'UTC';
      if (expr) shuttleSchedule = { expr, tz };
    }
  }

  // entry_point (felt) → isRoot (Portolan). Felt only emits this when true
  // (`omitempty`); a bare <slug>.md at .felt/ root is the only shape that
  // qualifies. Everything else is a directory fiber whose parentId is its
  // path's prefix.
  const isRoot = !!f.entry_point;
  const parentId = isRoot
    ? null
    : id.includes('/')
      ? id.slice(0, id.lastIndexOf('/'))
      : null;

  // kind / priority are Portolan/ASTRA conventions felt does not interpret.
  // They land in ExtraFields and surface as flat top-level JSON keys
  // (felt v1.0.4+); we read them here with stable defaults so downstream
  // consumers see a uniform shape.
  const kind = typeof f.kind === 'string' && f.kind ? f.kind : 'task';
  const priorityRaw = f.priority;
  const priority =
    typeof priorityRaw === 'number'
      ? priorityRaw
      : typeof priorityRaw === 'string'
        ? parseInt(priorityRaw, 10) || 2
        : 2;

  return {
    id,
    name,
    status,
    kind,
    priority,
    createdAt,
    closedAt,
    outcome,
    body,
    due,
    horizon,
    cold,
    tags,
    dependsOn,
    tempered,
    hasShuttleBlock: hasShuttleBlock || undefined,
    shuttleEnabled,
    shuttleKind,
    shuttleReviewState,
    shuttleSessionId,
    shuttleAgent,
    shuttleSchedule,
    parentId,
    isRoot,
  };
}

function pickIsoString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v && !v.startsWith('0001-')) {
      // 0001-01-01 is Go's zero-value time.Time when the field was absent
      // in source — felt emits it for the legacy `created_at` slot when
      // only the legacy `created` is set on disk. Treat as missing.
      return v;
    }
  }
  return undefined;
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Like `stringList`, but also accepts items shaped as `{id: "..."}` so
 * felt's object-form depends_on round-trips correctly. Tolerates mixed
 * arrays (some entries strings, some objects) — felt has shipped both
 * shapes in different fiber generations.
 */
function fiberRefList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string') {
        const trimmed = id.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Counts open fibers for a city by reading its .felt/ directory.
 */
export async function countOpenFibers(cityPath: string): Promise<number> {
  const fibers = await getOpenFibers(cityPath);
  return fibers.length;
}

/**
 * Gets all open fibers for a city.
 * Returns fibers with status !== 'closed', sorted by active first, then by priority.
 */
export async function getOpenFibers(cityPath: string): Promise<Fiber[]> {
  const fibers = await readAllFibers(cityPath);

  return fibers
    .filter(f => f.status !== 'closed')
    .sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return a.priority - b.priority;
    });
}

/**
 * Gets recently closed fibers for a city.
 */
export async function getRecentlyClosed(cityPath: string, limit: number): Promise<Fiber[]> {
  const fibers = await readAllFibers(cityPath);

  return fibers
    .filter(f => f.status === 'closed')
    .sort((a, b) => {
      const dateA = a.closedAt ? new Date(a.closedAt).getTime() : 0;
      const dateB = b.closedAt ? new Date(b.closedAt).getTime() : 0;
      return dateB - dateA;
    })
    .slice(0, limit);
}

/**
 * Gets all fibers (any status) matching a tag prefix.
 */
export async function getFibersByTag(cityPath: string, tagPrefix: string): Promise<Fiber[]> {
  const fibers = await readAllFibers(cityPath);
  return fibers.filter(f => f.tags?.some(t => t.startsWith(tagPrefix)));
}

/**
 * Read one fiber through `felt show -j` and map it onto the Portolan Fiber
 * interface. Used when a caller needs a single authoritative post-write read
 * without reparsing raw markdown on the Node side.
 */
export async function getFiber(cityPath: string, fiberId: string): Promise<Fiber | null> {
  try {
    const { stdout } = await execFileAsync(
      'felt',
      ['-C', cityPath, 'show', fiberId, '-j'],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return mapFeltJsonToFiber(JSON.parse(stdout));
  } catch (err) {
    console.warn(`felt show failed for ${cityPath}:${fiberId}:`, err);
    return null;
  }
}

/**
 * Gets all fibers for a city regardless of status. `withBody` is off by
 * default — pass `{ withBody: true }` only when the caller actually scores
 * or renders against fiber bodies (search, tapestry). Most consumers
 * (kanban, count probes, fiber list) only need metadata.
 */
export async function getAllFibers(
  cityPath: string,
  opts: { withBody?: boolean } = {},
): Promise<Fiber[]> {
  return readAllFibers(cityPath, opts);
}
