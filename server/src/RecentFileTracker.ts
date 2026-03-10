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
    const previous = entries[0];

    // Skip immediate duplicate touches to keep the trail meaningful.
    if (
      previous &&
      previous.toolName === toolName &&
      previous.fullPath === normalizedPath &&
      Math.abs(previous.timestamp - timestamp) < 1500
    ) {
      return;
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
