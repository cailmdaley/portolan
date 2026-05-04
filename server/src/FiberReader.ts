import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parse as parseYaml } from 'yaml';

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
   * `shuttle.review.state` for standing roles — `scheduled` | `awaiting` | `accepted`.
   * `awaiting` after a worker completes a run; the kanban routes the card to
   * the awaitingReview column even though `status` remains `active`. Cleared
   * (back to `scheduled`) by `shuttle-ctl accept`.
   */
  shuttleReviewState?: 'scheduled' | 'awaiting' | 'accepted';
  /**
   * `shuttle.session.id` — the session UUID of the most recently dispatched
   * worker. Written by the Shuttle daemon after a successful worker spawn via
   * `shuttle-ctl session-set`. Used to enable the "Resume previous" button on
   * awaiting-review Kanban cards. Absent when no session has been stored yet,
   * or after `shuttle-ctl session-clear`.
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
 * to `felt -C <city> ls -s all -j --body`.
 *
 * Why felt-mediated rather than disk-walking: felt v1.0.4+ emits the full
 * frontmatter (including tool-owned namespaces like `shuttle:`) as flat
 * top-level JSON keys. Walking the disk ourselves duplicates felt's
 * parsing logic in TS — and that duplication has bitten us before
 * (sibling: ai-futures/shuttle/finding-dispatcher-felt-show-json-misses-
 * shuttle-block in the loom — felt's lossy JSON forced the shuttle
 * dispatcher into per-key --field workarounds, since fixed at the felt
 * layer). The rule we now enforce: **felt owns reading; tools own
 * write/orchestration.** Each fiber consumer stays thin.
 *
 * Body is included via `--body` so existing search/tapestry callers see
 * the same Fiber shape they did under the disk-walking implementation.
 * The cost is ~3-4× larger JSON than metadata-only; acceptable for a
 * single subprocess per refresh and far cheaper than the equivalent
 * disk-walk-and-yaml-parse-in-Node loop.
 */
async function readAllFibers(cityPath: string): Promise<Fiber[]> {
  const feltPath = join(cityPath, '.felt');

  if (!existsSync(feltPath)) {
    return [];
  }

  let stdout: string;
  try {
    const result = await execFileAsync(
      'felt',
      ['-C', cityPath, 'ls', '-s', 'all', '-j', '--body'],
      // The loom carries thousands of fibers; a comfortable ceiling for the
      // JSON payload is needed so node doesn't truncate. Empirically ~10MB
      // for a 3000-fiber loom with bodies; allow 64MB for headroom.
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
 * Map one entry from `felt ls -j` JSON output onto the Portolan Fiber
 * interface. Mirrors what `parseFiber` does for raw markdown — same shape
 * out, different shape in. Tool-owned namespaces (`shuttle:`, `tempered:`,
 * `depends_on:`) arrive as native JSON values (felt v1.0.4+) so we read
 * them directly rather than re-parsing YAML.
 *
 * `kind` and `priority` are not part of felt's serialized model — they're
 * Portolan/ASTRA conventions felt does not interpret. We default them to
 * what `parseFiber` falls back to so downstream consumers see a uniform
 * shape regardless of source.
 */
function mapFeltJsonToFiber(item: unknown): Fiber | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const f = item as Record<string, unknown>;

  const id = typeof f.id === 'string' ? f.id : '';
  if (!id) return null;

  const status = typeof f.status === 'string' ? f.status : '';
  const name = typeof f.name === 'string' && f.name ? f.name : id;
  const outcome = typeof f.outcome === 'string' ? f.outcome : undefined;
  const body = typeof f.body === 'string' ? f.body : undefined;

  // Prefer canonical *_at fields; fall back to legacy `created`/`closed`
  // for older fibers that haven't been migrated.
  const createdAt = pickIsoString(f, ['created_at', 'created']) ?? '';
  const closedAt = pickIsoString(f, ['closed_at', 'closed']);

  const tags = stringList(f.tags);
  const dependsOn = stringList(f.depends_on) ?? stringList(f['depends-on']);

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
  // (felt v1.0.4+); we read them here with the same defaults `parseFiber`
  // falls back to, so downstream consumers see a uniform shape.
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
 * Gets all fibers for a city regardless of status.
 */
export async function getAllFibers(cityPath: string): Promise<Fiber[]> {
  return readAllFibers(cityPath);
}

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse a fiber file into a Fiber object.
 *
 * @param id The fiber ID (slug, e.g., "my-fiber")
 * @param content File content with YAML frontmatter
 */
export function parseFiber(id: string, content: string): Fiber {

  // Extract frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();

  // Parse the frontmatter once with a real YAML parser so we get block
  // scalars (`|`, `|-`, `>`), multi-line flow strings, and proper unquoting
  // for free. The previous regex-based approach treated `outcome: |-`
  // as a literal string `"|-"` and silently corrupted any multi-line
  // outcome — see ai-futures/portolan/gotchas/constitution-draft-prefix-in-title
  // for the surfacing.
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(frontmatter);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // Bad YAML → empty frontmatter. The fiber still gets included with
    // defaults (matches the old regex parser's silent-skip behavior).
  }

  // Single-value field. Coerces Date (from ISO timestamps in YAML) back
  // to ISO string so downstream consumers see strings consistently.
  const getField = (name: string): string | undefined => {
    const v = fm[name];
    if (v === null || v === undefined) return undefined;
    if (v instanceof Date) return v.toISOString();
    return String(v).trim();
  };

  // List field (YAML sequence). Strings get trimmed; other types are
  // coerced via String().
  const getListField = (name: string): string[] | undefined => {
    const v = fm[name];
    if (!Array.isArray(v)) return undefined;
    return v.map(item => String(item).trim());
  };

  // Normalize tags: split comma-separated values within a single YAML list item
  // into individual tags. Handles "claim, tapestry:foo" → ["claim", "tapestry:foo"]
  const rawTags = getListField('tags');
  const tags = rawTags?.flatMap(t => t.includes(',') ? t.split(',').map(s => s.trim()).filter(Boolean) : [t]);
  const dependsOn = getListField('depends-on') ?? getListField('depends_on');

  // tempered: human-acceptance signal. Parsed permissively — frontmatter
  // convention is `tempered: true` but YAML truthiness is forgiving.
  const temperedRaw = getField('tempered');
  const tempered = temperedRaw === undefined
    ? undefined
    : /^(true|yes|1)$/i.test(temperedRaw);

  // hasShuttleBlock: true when the fiber carries a shuttle: frontmatter block.
  // This is the dispatch-eligibility signal post-migration (replaces the
  // constitution/draft tag predicate). Non-null object means the block is present.
  const shuttleRaw = fm['shuttle'];
  const hasShuttleBlock = shuttleRaw !== null && shuttleRaw !== undefined && typeof shuttleRaw === 'object' && !Array.isArray(shuttleRaw);
  // shuttleEnabled: the `shuttle.enabled` field. Drives drafts vs inFlight split:
  // false = drafts (installed, not yet queued for dispatch); true = inFlight.
  const shuttleEnabled: boolean | undefined = hasShuttleBlock
    ? (shuttleRaw as Record<string, unknown>)['enabled'] === false ? false : true
    : undefined;

  // shuttleKind: oneshot (default when block present but kind absent) | standing.
  // Standing roles have richer lifecycle and need different transition semantics.
  let shuttleKind: 'oneshot' | 'standing' | undefined;
  if (hasShuttleBlock) {
    const k = (shuttleRaw as Record<string, unknown>)['kind'];
    shuttleKind = k === 'standing' ? 'standing' : 'oneshot';
  }

  // shuttleReviewState: shuttle.review.state — only meaningful for standing roles.
  // Reads as 'awaiting' between worker exit and human accept.
  let shuttleReviewState: 'scheduled' | 'awaiting' | 'accepted' | undefined;
  if (hasShuttleBlock) {
    const review = (shuttleRaw as Record<string, unknown>)['review'];
    if (review && typeof review === 'object' && !Array.isArray(review)) {
      const s = (review as Record<string, unknown>)['state'];
      if (s === 'scheduled' || s === 'awaiting' || s === 'accepted') {
        shuttleReviewState = s;
      }
    }
  }

  // shuttleSessionId: shuttle.session.id — the harness-native session UUID from
  // the most recent dispatch. Written by the Shuttle daemon via `shuttle-ctl
  // session-set`; used to enable "Resume previous" on awaiting-review cards.
  let shuttleSessionId: string | undefined;
  if (hasShuttleBlock) {
    const session = (shuttleRaw as Record<string, unknown>)['session'];
    if (session && typeof session === 'object' && !Array.isArray(session)) {
      const id = (session as Record<string, unknown>)['id'];
      if (typeof id === 'string' && id) shuttleSessionId = id;
    }
  }

  // shuttleAgent: shuttle.agent — the agent id to dispatch with.
  let shuttleAgent: string | undefined;
  if (hasShuttleBlock) {
    const a = (shuttleRaw as Record<string, unknown>)['agent'];
    if (typeof a === 'string' && a) shuttleAgent = a;
  }

  // shuttleSchedule: shuttle.schedule.{expr,tz} — for standing roles.
  // Pre-CLI fibers may carry the legacy `timezone` key; mirror both.
  let shuttleSchedule: { expr: string; tz: string } | undefined;
  if (hasShuttleBlock) {
    const sched = (shuttleRaw as Record<string, unknown>)['schedule'];
    if (sched && typeof sched === 'object' && !Array.isArray(sched)) {
      const m = sched as Record<string, unknown>;
      const expr = typeof m['expr'] === 'string' ? (m['expr'] as string).trim() : '';
      const tzRaw = typeof m['tz'] === 'string'
        ? (m['tz'] as string)
        : typeof m['timezone'] === 'string'
          ? (m['timezone'] as string)
          : '';
      const tz = tzRaw.trim() || 'UTC';
      if (expr) shuttleSchedule = { expr, tz };
    }
  }

  return {
    id,
    name: getField('name') || id,
    status: getField('status') || '',
    kind: getField('kind') || 'task',
    priority: parseInt(getField('priority') || '2', 10),
    createdAt: getField('created-at') || getField('created') || '',
    closedAt: getField('closed-at') || getField('closed') || undefined,
    outcome: getField('outcome') || undefined,
    body: body || undefined,
    tags: tags,
    dependsOn: dependsOn,
    tempered: tempered,
    hasShuttleBlock: hasShuttleBlock || undefined,
    shuttleEnabled,
    shuttleKind,
    shuttleReviewState,
    shuttleSessionId,
    shuttleAgent,
    shuttleSchedule,
  };
}
