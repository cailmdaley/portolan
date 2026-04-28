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

import type { ServerResponse } from 'http';
import type { URL } from 'url';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getAllFibers, type Fiber } from './FiberReader.js';

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
}

export interface KanbanColumns {
  inFlight: KanbanCard[];
  awaitingReview: KanbanCard[];
  tempered: KanbanCard[];
}

export interface KanbanResponse {
  feltHost: string;
  columns: KanbanColumns;
  totals: { inFlight: number; awaitingReview: number; tempered: number };
  /** Total tempered count *before* slicing — UI shows recent N but we surface the full count. */
  temperedTotal: number;
  generatedAt: number;
}

interface HttpApiKanbanOptions {
  /** Felt host (parent of `.felt/`). Defaults to ~/loom. */
  feltHost?: string;
  /** Max tempered cards to return. Defaults to 30. */
  temperedLimit?: number;
}

export class HttpApiKanban {
  private readonly feltHost: string;
  private readonly temperedLimit: number;

  constructor(opts: HttpApiKanbanOptions = {}) {
    this.feltHost = opts.feltHost ?? join(homedir(), 'loom');
    this.temperedLimit = opts.temperedLimit ?? 30;
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

      const inFlight: KanbanCard[] = [];
      const awaitingReview: KanbanCard[] = [];
      const tempered: KanbanCard[] = [];

      for (const f of constitutional) {
        const card = this.toCard(f, byId);
        if (f.status !== 'closed') {
          inFlight.push(card);
        } else if (f.tempered === true) {
          tempered.push(card);
        } else {
          awaitingReview.push(card);
        }
      }

      // Sort
      inFlight.sort(byCreatedAtDesc);
      awaitingReview.sort(byClosedAtDesc);
      tempered.sort(byClosedAtDesc);

      const temperedTotal = tempered.length;
      const temperedSliced = tempered.slice(0, this.temperedLimit);

      this.json(res, 200, {
        feltHost: this.feltHost,
        columns: {
          inFlight,
          awaitingReview,
          tempered: temperedSliced,
        },
        totals: {
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

  // ---------------------------------------------------------------------------

  private toCard(f: Fiber, byId: Map<string, Fiber>): KanbanCard {
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
    };
  }

  private emptyResponse(): KanbanResponse {
    return {
      feltHost: this.feltHost,
      columns: { inFlight: [], awaitingReview: [], tempered: [] },
      totals: { inFlight: 0, awaitingReview: 0, tempered: 0 },
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
