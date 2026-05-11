import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

export interface RecentFileEntry {
  toolName: string;
  fullPath: string;
  basename: string;
  timestamp: number;
}

/**
 * Ring buffer of recent file touches per worker session.
 *
 * The worker hover tooltip asks for `/recent-files?sessionId=...`; that
 * association is stable across browser refreshes and server restarts because
 * local session IDs derive from tmux session names and remote session IDs
 * derive from origin+tmux session. Persist the tiny per-session trail on disk
 * so refreshes, dev restarts, and brief remote reconnects do not wipe the
 * context the user relies on when returning to a worker.
 */
export class RecentFileTracker {
  private readonly maxEntriesPerSession: number;
  private readonly persistencePath: string | null;
  private readonly entriesBySessionId: Map<string, RecentFileEntry[]> = new Map();

  constructor(
    maxEntriesPerSession: number = 10,
    persistencePath: string | null = defaultPersistencePath(),
  ) {
    this.maxEntriesPerSession = maxEntriesPerSession;
    this.persistencePath = persistencePath;
    this.load();
  }

  recordTouch(
    workerSessionId: string,
    toolName: string,
    fullPath: string,
    timestamp: number = Date.now()
  ): void {
    if (!workerSessionId || !fullPath) return;

    const normalizedPath = fullPath.trim();
    if (!normalizedPath) return;

    const entries = this.entriesBySessionId.get(workerSessionId) ?? [];

    // Drop any prior entry for the same path — re-touching a file should
    // refresh its position in the trail (most-recent-first), not append a
    // duplicate. Read-then-Edit on the same path collapses to one entry,
    // and the trail of `limit=4` distinct paths actually shows four files.
    const existingIdx = entries.findIndex(e => e.fullPath === normalizedPath);
    if (existingIdx !== -1) {
      entries.splice(existingIdx, 1);
    }

    entries.unshift({
      toolName,
      fullPath: normalizedPath,
      basename: basename(normalizedPath),
      timestamp,
    });
    if (entries.length > this.maxEntriesPerSession) {
      entries.length = this.maxEntriesPerSession;
    }

    this.entriesBySessionId.set(workerSessionId, entries);
    this.persist();
  }

  getRecentFiles(workerSessionId: string, limit: number = 5): RecentFileEntry[] {
    const entries = this.entriesBySessionId.get(workerSessionId) ?? [];
    const safeLimit = Math.max(1, Math.min(limit, this.maxEntriesPerSession));
    return entries.slice(0, safeLimit);
  }

  removeSession(workerSessionId: string): void {
    // A missing session often means a browser/dev refresh, transient tmux
    // discovery gap, or remote-agent reconnect. Keep the trail so it is still
    // available if the same worker session ID reappears.
    void workerSessionId;
  }

  getSessionCount(): number {
    return this.entriesBySessionId.size;
  }

  getTotalEntryCount(): number {
    let total = 0;
    for (const entries of this.entriesBySessionId.values()) {
      total += entries.length;
    }
    return total;
  }

  private load(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, 'utf-8')) as unknown;
      if (!isPersistenceFile(parsed)) return;
      this.entriesBySessionId.clear();
      for (const [sessionId, entries] of Object.entries(parsed.sessions)) {
        const cleanEntries = entries
          .filter(isRecentFileEntry)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, this.maxEntriesPerSession);
        if (cleanEntries.length > 0) {
          this.entriesBySessionId.set(sessionId, cleanEntries);
        }
      }
    } catch (err) {
      console.warn('[RecentFileTracker] failed to load persisted recent files:', err);
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    const sessions: Record<string, RecentFileEntry[]> = {};
    for (const [sessionId, entries] of this.entriesBySessionId) {
      sessions[sessionId] = entries.slice(0, this.maxEntriesPerSession);
    }
    const payload: PersistenceFile = { version: 1, sessions };
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      const tmpPath = `${this.persistencePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(tmpPath, this.persistencePath);
    } catch (err) {
      console.warn('[RecentFileTracker] failed to persist recent files:', err);
    }
  }
}

interface PersistenceFile {
  version: 1;
  sessions: Record<string, RecentFileEntry[]>;
}

function defaultPersistencePath(): string | null {
  return process.env.NODE_ENV === 'test'
    ? null
    : join(homedir(), '.portolan', 'data', 'recent-files.json');
}

function isPersistenceFile(value: unknown): value is PersistenceFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; sessions?: unknown };
  return candidate.version === 1
    && !!candidate.sessions
    && typeof candidate.sessions === 'object'
    && !Array.isArray(candidate.sessions);
}

function isRecentFileEntry(value: unknown): value is RecentFileEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.toolName === 'string'
    && typeof entry.fullPath === 'string'
    && typeof entry.basename === 'string'
    && typeof entry.timestamp === 'number'
    && Number.isFinite(entry.timestamp);
}
