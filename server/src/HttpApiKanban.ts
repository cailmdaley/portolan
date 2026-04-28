/**
 * HttpApiKanban — global kanban view of constitution-tagged fibers.
 *
 * Reads fibers from a felt host (defaults to ~/loom — the loom monorepo,
 * which symlinks every project's `.felt/`), filters to constitution-tagged,
 * and groups by lifecycle stage:
 *
 *   - in-flight       : status != closed (open / active / dispatchable)
 *   - awaiting-review : status == closed && !tempered (agent-paused handoff)
 *   - tempered        : status == closed && tempered:true (human-accepted)
 *
 * The "awaiting-review" column is the human-tempering action queue and the
 * primary reason this view exists. See:
 * .felt/ai-futures/portolan/shuttle/constitution-shuttle.
 *
 * v0 is read-only — clicking a card opens the fiber's md in vellum on the
 * frontend; tempering/un-tempering happens via CLI for now. Will grow to
 * include Shuttle dispatch state and an inline temper button.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { URL } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getAllFibers, type Fiber } from './FiberReader.js';
import { listShuttleSessions, shuttleSessionName } from './Shuttle.js';

export interface KanbanCard {
  id: string;
  name: string;
  /** Absolute filesystem path to the fiber's md (for open-in-vellum). */
  path: string;
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
}

export interface KanbanColumns {
  /** Constitution-tagged AND draft-tagged. Brainstorming, hidden from Shuttle. */
  drafts: KanbanCard[];
  /** Constitution-tagged, NOT draft, status != closed. Queue + active are one bucket. */
  inFlight: KanbanCard[];
  /** Constitution-tagged, status=closed && !tempered (the human-tempering queue). */
  awaitingReview: KanbanCard[];
  /** Constitution-tagged, status=closed && tempered:true (recent N). */
  tempered: KanbanCard[];
}

export interface KanbanResponse {
  feltHost: string;
  columns: KanbanColumns;
  totals: { drafts: number; inFlight: number; awaitingReview: number; tempered: number };
  /** Total tempered count *before* slicing — UI shows recent N but we surface the full count. */
  temperedTotal: number;
  generatedAt: number;
}

interface HttpApiKanbanOptions {
  /** Felt host (parent of `.felt/`). Defaults to ~/loom. */
  feltHost?: string;
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
}

/**
 * Where a transition can land a card.
 *
 *   drafts          → adds the `draft` tag, parks in drafts column
 *   inFlight        → removes `draft` tag, status=active, clears closed-at
 *   awaitingReview  → status=closed, tempered=false (agent-paused handoff)
 *   tempered        → status=closed, tempered=true (human-accepted)
 *
 * Legacy aliases kept for v0/v1 clients: `queued`/`active` both fold into
 * `inFlight` (the queued vs active split was decoration, not workflow).
 */
export type KanbanTarget =
  | 'drafts'
  | 'inFlight'
  | 'awaitingReview'
  | 'tempered'
  // Legacy aliases (queued/active mapped to inFlight)
  | 'queued'
  | 'active';

/** What POST /kanban/transition expects in the body. */
export interface KanbanTransitionRequest {
  fiberId: string;
  target: KanbanTarget;
}

export class HttpApiKanban {
  private readonly feltHost: string;
  private readonly temperedLimit: number;
  private readonly now: () => Date;
  private readonly listSessions: () => string[];

  constructor(opts: HttpApiKanbanOptions = {}) {
    this.feltHost = opts.feltHost ?? join(homedir(), 'loom');
    this.temperedLimit = opts.temperedLimit ?? 30;
    this.now = opts.now ?? (() => new Date());
    this.listSessions = opts.listSessions ?? listShuttleSessions;
  }

  /** GET /kanban → KanbanResponse. */
  async handleKanban(_url: URL, res: ServerResponse): Promise<void> {
    try {
      if (!existsSync(join(this.feltHost, '.felt'))) {
        this.json(res, 200, this.emptyResponse());
        return;
      }

      const all = await getAllFibers(this.feltHost);
      const byId = new Map(all.map(f => [f.id, f]));
      const constitutional = all.filter(f => f.tags?.includes('constitution'));

      // Probe live shuttle workers — drives the running-worker indicator on
      // in-flight cards, and bumps them to the top of the column.
      const liveSessions = new Set(this.listSessions());

      const drafts: KanbanCard[] = [];
      const inFlight: KanbanCard[] = [];
      const awaitingReview: KanbanCard[] = [];
      const tempered: KanbanCard[] = [];

      for (const f of constitutional) {
        const card = this.toCard(f, byId, liveSessions);
        const isDraft = f.tags?.includes('draft') ?? false;
        if (f.status !== 'closed') {
          if (isDraft) drafts.push(card);
          else inFlight.push(card);
        } else if (f.tempered === true) {
          tempered.push(card);
        } else {
          awaitingReview.push(card);
        }
      }

      // Sort:
      //   drafts          : most-recently-created first (these are works-in-progress)
      //   inFlight        : running workers / status:active first, then by createdAt desc
      //   awaitingReview  : most-recently-closed first
      //   tempered        : most-recently-closed first
      drafts.sort(byCreatedAtDesc);
      inFlight.sort((a, b) => {
        const aActive = a.runningWorker || a.status === 'active' ? 0 : 1;
        const bActive = b.runningWorker || b.status === 'active' ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return byCreatedAtDesc(a, b);
      });
      awaitingReview.sort(byClosedAtDesc);
      tempered.sort(byClosedAtDesc);

      const temperedTotal = tempered.length;
      const temperedSliced = tempered.slice(0, this.temperedLimit);

      this.json(res, 200, {
        feltHost: this.feltHost,
        columns: {
          drafts,
          inFlight,
          awaitingReview,
          tempered: temperedSliced,
        },
        totals: {
          drafts: drafts.length,
          inFlight: inFlight.length,
          awaitingReview: awaitingReview.length,
          tempered: temperedSliced.length,
        },
        temperedTotal,
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
    const validTargets: KanbanTarget[] = ['drafts', 'inFlight', 'queued', 'active', 'awaitingReview', 'tempered'];
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
   */
  async applyTransition(fiberId: string, target: KanbanTarget): Promise<KanbanCard> {
    const all = await getAllFibers(this.feltHost);
    const fiber = all.find(f => f.id === fiberId);
    if (!fiber) throw new Error(`fiber not found: ${fiberId}`);
    if (!fiber.tags?.includes('constitution')) {
      throw new Error(
        `kanban only mutates constitution-tagged fibers; ${fiberId} is tagged ${(fiber.tags ?? []).join(', ') || '(none)'}`,
      );
    }

    const segments = fiberId.split('/');
    const basename = segments[segments.length - 1];
    const path = fiber.isRoot
      ? join(this.feltHost, '.felt', `${basename}.md`)
      : join(this.feltHost, '.felt', fiberId, `${basename}.md`);

    if (!existsSync(path)) {
      throw new Error(`fiber file missing on disk: ${path}`);
    }

    const raw = readFileSync(path, 'utf-8');
    const updated = applyTargetToFrontmatter(raw, target, this.now().toISOString());
    if (updated !== raw) {
      writeFileSync(path, updated, 'utf-8');
    }

    // Re-read to confirm and produce the canonical card.
    const after = await getAllFibers(this.feltHost);
    const refreshedById = new Map(after.map(f => [f.id, f]));
    const refreshed = refreshedById.get(fiberId);
    if (!refreshed) throw new Error(`fiber disappeared after write: ${fiberId}`);
    return this.toCard(refreshed, refreshedById);
  }

  // ---------------------------------------------------------------------------

  private toCard(f: Fiber, byId: Map<string, Fiber>, liveSessions: Set<string> = new Set()): KanbanCard {
    const dependsOn = f.dependsOn ?? [];
    const dependsOnSatisfied =
      dependsOn.length === 0 ||
      dependsOn.every(d => byId.get(d)?.tempered === true);

    // Path on disk: the fiber id is a slash-joined slug under <feltHost>/.felt/.
    // Per FiberReader, a directory-based fiber lives at <id>/<basename>.md;
    // a top-level entry-point fiber lives bare at <id>.md. We don't have the
    // shape on the parsed Fiber, so fall back to the directory shape (the
    // common case for nested fibers) and let the frontend handle either by
    // probing if needed. For top-level (`isRoot:true`) fibers we emit the
    // bare `.md` path.
    const segments = f.id.split('/');
    const basename = segments[segments.length - 1];
    const path = f.isRoot
      ? join(this.feltHost, '.felt', `${basename}.md`)
      : join(this.feltHost, '.felt', f.id, `${basename}.md`);

    const expectedSession = shuttleSessionName(f.id);
    const runningWorker = liveSessions.has(expectedSession) ? expectedSession : undefined;

    return {
      id: f.id,
      name: f.name,
      path,
      status: f.status,
      outcome: f.outcome,
      tags: f.tags,
      createdAt: f.createdAt,
      closedAt: f.closedAt,
      tempered: f.tempered,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      dependsOnSatisfied,
      runningWorker,
    };
  }

  private emptyResponse(): KanbanResponse {
    return {
      feltHost: this.feltHost,
      columns: { drafts: [], inFlight: [], awaitingReview: [], tempered: [] },
      totals: { drafts: 0, inFlight: 0, awaitingReview: 0, tempered: 0 },
      temperedTotal: 0,
      generatedAt: Date.now(),
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
  }
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
  //   drafts          → keep status (or default active), add 'draft' tag, tempered=false, clear closed-at
  //   inFlight        → status=active, remove 'draft' tag, tempered=false, clear closed-at
  //   queued/active   → legacy aliases for inFlight (queued vs active was decoration)
  //   awaitingReview  → status=closed, tempered=false (agent-paused handoff)
  //   tempered        → status=closed, tempered=true (human-accepted)
  let status: string | null;  // null = leave untouched
  let tempered: boolean;
  let closedAtAction: 'set-if-missing' | 'clear';
  let tagsToAdd: string[] = [];
  let tagsToRemove: string[] = [];
  switch (target) {
    case 'drafts':
      // Don't force a status when filing as draft — preserve whatever shape
      // the fiber already has (often `open` from felt add). The draft tag is
      // what matters for kanban classification.
      status = null;
      tempered = false;
      closedAtAction = 'clear';
      tagsToAdd = ['draft'];
      break;
    case 'inFlight':
    case 'queued':
    case 'active':
      status = 'active';
      tempered = false;
      closedAtAction = 'clear';
      tagsToRemove = ['draft'];
      break;
    case 'awaitingReview':
      status = 'closed';
      tempered = false;
      closedAtAction = 'set-if-missing';
      break;
    case 'tempered':
      status = 'closed';
      tempered = true;
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
  setOrInsertScalar('tempered', tempered ? 'true' : 'false');

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
  opts: { add?: string[]; remove?: string[] },
): void {
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
