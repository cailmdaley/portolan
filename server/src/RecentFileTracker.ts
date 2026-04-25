import { basename } from 'path';

export interface RecentFileEntry {
  toolName: string;
  fullPath: string;
  basename: string;
  timestamp: number;
}

/**
 * In-memory ring buffer of recent file touches per worker session.
 * This is intentionally ephemeral and resets on server restart.
 */
export class RecentFileTracker {
  private readonly maxEntriesPerSession: number;
  private readonly entriesBySessionId: Map<string, RecentFileEntry[]> = new Map();

  constructor(maxEntriesPerSession: number = 10) {
    this.maxEntriesPerSession = maxEntriesPerSession;
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
  }

  getRecentFiles(workerSessionId: string, limit: number = 5): RecentFileEntry[] {
    const entries = this.entriesBySessionId.get(workerSessionId) ?? [];
    const safeLimit = Math.max(1, Math.min(limit, this.maxEntriesPerSession));
    return entries.slice(0, safeLimit);
  }

  removeSession(workerSessionId: string): void {
    this.entriesBySessionId.delete(workerSessionId);
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
}
