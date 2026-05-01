/**
 * RecentsStore — Stage G of constitution-portolan-navigation-layer.
 *
 * SQLite-backed view log for fibers + files, surfaced through the Find
 * dashboard's Recents column. Persists across server restarts so the
 * "open a fiber 5×, restart, view_count is 5" quality bar holds. One
 * row per (viewer_kind, viewer_id, origin_id, city_id, kind, path) so
 * the human and an agent both viewing the same fiber stay distinct (the
 * UI rolls them up at query time).
 *
 * Schema follows the constitution's signature
 * `(viewer_kind, viewer_id, originId, path, last_viewed_at, view_count)`,
 * with two structural additions: `city_id` (multi-city paths can collide)
 * and `kind` ('fiber' | 'file', so the UI's kind badge query is a column
 * read instead of a path-shape inference).
 *
 * Uses `node:sqlite` from Node 22+ — no native dependency, no install
 * step. Database file lives at ~/.portolan/data/recents.sqlite alongside
 * events.jsonl; the directory is created on demand if missing.
 */

import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
// node:sqlite is stable in Node 22+ (still emits ExperimentalWarning on
// some 22.x lines; default-on in 24+). Imported through createRequire so
// this module loads cleanly on older Node where node:sqlite isn't
// resolvable — the store no-ops and the Find dashboard's Recents column
// renders empty rather than crashing the whole server boot.
import { createRequire } from 'module';

export type RecentViewerKind = 'human' | 'agent';
export type RecentKind = 'fiber' | 'file';

export interface RecordViewArgs {
  viewerKind: RecentViewerKind;
  viewerId: string;
  originId: string;
  cityId: string;
  kind: RecentKind;
  path: string;
  /** Optional override; defaults to Date.now(). */
  timestamp?: number;
}

export interface RecentEntry {
  originId: string;
  cityId: string;
  kind: RecentKind;
  path: string;
  lastViewedAt: number;
  viewCount: number;
  /** Roll-up of viewer kinds that contributed to this entry. */
  viewerKinds: RecentViewerKind[];
}

export interface QueryRecentsArgs {
  /** Limit on city_id; omit for cross-city. */
  cityId?: string;
  /** Limit on kind; omit for both. */
  kind?: RecentKind;
  /** Default 8. Capped at 100. */
  limit?: number;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all<T = unknown>(...params: unknown[]): T[];
  get<T = unknown>(...params: unknown[]): T | undefined;
}

interface NodeSqlite {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

function tryLoadSqlite(): NodeSqlite | null {
  try {
    // createRequire avoids a static `import('node:sqlite')` so older Node
    // can still parse this module. The runtime fallback drops the store
    // into a no-op rather than crashing the server.
    const req = createRequire(import.meta.url);
    return req('node:sqlite') as NodeSqlite;
  } catch (err) {
    console.warn('[RecentsStore] node:sqlite unavailable; recents disabled:', err);
    return null;
  }
}

export class RecentsStore {
  private readonly db: SqliteDatabase | null;
  private readonly upsertStmt: SqliteStatement | null;
  private readonly queryAllStmt: SqliteStatement | null;
  private readonly queryByCityStmt: SqliteStatement | null;
  private readonly queryAllKindStmt: SqliteStatement | null;
  private readonly queryByCityKindStmt: SqliteStatement | null;
  private readonly enabled: boolean;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? join(homedir(), '.portolan', 'data', 'recents.sqlite');
    if (resolvedPath !== ':memory:') {
      try {
        mkdirSync(dirname(resolvedPath), { recursive: true });
      } catch {
        // ignore — open will fail clearly if the dir is unusable
      }
    }

    const sqlite = tryLoadSqlite();
    if (!sqlite) {
      this.db = null;
      this.upsertStmt = null;
      this.queryAllStmt = null;
      this.queryByCityStmt = null;
      this.queryAllKindStmt = null;
      this.queryByCityKindStmt = null;
      this.enabled = false;
      return;
    }

    this.db = new sqlite.DatabaseSync(resolvedPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recents (
        viewer_kind    TEXT    NOT NULL CHECK (viewer_kind IN ('human','agent')),
        viewer_id      TEXT    NOT NULL,
        origin_id      TEXT    NOT NULL,
        city_id        TEXT    NOT NULL,
        kind           TEXT    NOT NULL CHECK (kind IN ('fiber','file')),
        path           TEXT    NOT NULL,
        last_viewed_at INTEGER NOT NULL,
        view_count     INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (viewer_kind, viewer_id, origin_id, city_id, kind, path)
      );
      CREATE INDEX IF NOT EXISTS recents_last_viewed_at
        ON recents (last_viewed_at DESC);
      CREATE INDEX IF NOT EXISTS recents_city_last_viewed_at
        ON recents (city_id, last_viewed_at DESC);
    `);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO recents
        (viewer_kind, viewer_id, origin_id, city_id, kind, path,
         last_viewed_at, view_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (viewer_kind, viewer_id, origin_id, city_id, kind, path)
      DO UPDATE SET
        view_count     = view_count + 1,
        last_viewed_at = MAX(last_viewed_at, excluded.last_viewed_at)
    `);

    // Aggregation queries — roll up per resource (origin+city+kind+path),
    // keeping the latest view across viewers and summing counts. The
    // viewer_kind concat lets the UI render human/agent badges per row.
    const aggregateSelect = `
      SELECT
        origin_id      AS originId,
        city_id        AS cityId,
        kind           AS kind,
        path           AS path,
        MAX(last_viewed_at) AS lastViewedAt,
        SUM(view_count)     AS viewCount,
        GROUP_CONCAT(DISTINCT viewer_kind) AS viewerKindsCsv
      FROM recents
    `;
    const groupOrder = `
      GROUP BY origin_id, city_id, kind, path
      ORDER BY MAX(last_viewed_at) DESC
      LIMIT ?
    `;

    this.queryAllStmt = this.db.prepare(`${aggregateSelect}${groupOrder}`);
    this.queryByCityStmt = this.db.prepare(
      `${aggregateSelect} WHERE city_id = ? ${groupOrder}`,
    );
    this.queryAllKindStmt = this.db.prepare(
      `${aggregateSelect} WHERE kind = ? ${groupOrder}`,
    );
    this.queryByCityKindStmt = this.db.prepare(
      `${aggregateSelect} WHERE city_id = ? AND kind = ? ${groupOrder}`,
    );
    this.enabled = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordView(args: RecordViewArgs): void {
    if (!this.enabled || !this.upsertStmt) return;
    const {
      viewerKind,
      viewerId,
      originId,
      cityId,
      kind,
      path,
      timestamp = Date.now(),
    } = args;
    if (!viewerId || !originId || !cityId || !path) {
      // Filter out incomplete records before they pollute the table —
      // a fiber click with no resolved cityId isn't useful in the
      // Recents column anyway. Caller logs and drops.
      return;
    }
    try {
      this.upsertStmt.run(
        viewerKind,
        viewerId,
        originId,
        cityId,
        kind,
        path,
        timestamp,
      );
    } catch (err) {
      console.warn('[RecentsStore] recordView failed:', err);
    }
  }

  getRecents(args: QueryRecentsArgs = {}): RecentEntry[] {
    if (!this.enabled) return [];
    const limitRaw = args.limit ?? 8;
    const limit = Math.max(1, Math.min(100, limitRaw | 0 || 8));
    const stmt = args.cityId && args.kind
      ? this.queryByCityKindStmt
      : args.cityId
        ? this.queryByCityStmt
        : args.kind
          ? this.queryAllKindStmt
          : this.queryAllStmt;
    if (!stmt) return [];
    type Row = {
      originId: string;
      cityId: string;
      kind: RecentKind;
      path: string;
      lastViewedAt: number;
      viewCount: number;
      viewerKindsCsv: string | null;
    };
    let rows: Row[];
    try {
      rows = args.cityId && args.kind
        ? stmt.all<Row>(args.cityId, args.kind, limit)
        : args.cityId
          ? stmt.all<Row>(args.cityId, limit)
          : args.kind
            ? stmt.all<Row>(args.kind, limit)
            : stmt.all<Row>(limit);
    } catch (err) {
      console.warn('[RecentsStore] getRecents failed:', err);
      return [];
    }
    return rows.map((row) => ({
      originId: row.originId,
      cityId: row.cityId,
      kind: row.kind,
      path: row.path,
      lastViewedAt: row.lastViewedAt,
      viewCount: row.viewCount,
      viewerKinds: parseViewerKinds(row.viewerKindsCsv),
    }));
  }

  /** Diagnostic only — counts every row including duplicates per viewer. */
  getRowCount(): number {
    if (!this.enabled || !this.db) return 0;
    const stmt = this.db.prepare('SELECT COUNT(*) AS n FROM recents');
    const result = stmt.get<{ n: number }>();
    return result?.n ?? 0;
  }

  close(): void {
    this.db?.close();
  }
}

function parseViewerKinds(csv: string | null): RecentViewerKind[] {
  if (!csv) return [];
  const parts = csv.split(',');
  const out: RecentViewerKind[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === 'human' || trimmed === 'agent') {
      if (!out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}
