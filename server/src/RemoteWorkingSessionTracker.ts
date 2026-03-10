export type SessionStatus = 'idle' | 'working' | 'offline';

export interface ExpiredRemoteSession {
  originId: string;
  tmuxSession: string;
  lastActivity: number;
}

export interface RemoteWorkingSessionTrackerStats {
  originCount: number;
  sessionCount: number;
}

/**
 * Owns remote "working" timeout state using explicit origin/session structure.
 * This avoids delimiter parsing pitfalls and guarantees deterministic cleanup.
 */
export class RemoteWorkingSessionTracker {
  private byOrigin = new Map<string, Map<string, number>>();

  touch(originId: string, tmuxSession: string, timestamp = Date.now()): void {
    let sessions = this.byOrigin.get(originId);
    if (!sessions) {
      sessions = new Map<string, number>();
      this.byOrigin.set(originId, sessions);
    }
    sessions.set(tmuxSession, timestamp);
  }

  clear(originId: string, tmuxSession: string): void {
    const sessions = this.byOrigin.get(originId);
    if (!sessions) return;
    sessions.delete(tmuxSession);
    if (sessions.size === 0) {
      this.byOrigin.delete(originId);
    }
  }

  clearOrigin(originId: string): void {
    this.byOrigin.delete(originId);
  }

  reconcile(originId: string, tmuxSession: string, status: SessionStatus, timestamp = Date.now()): void {
    if (status === 'working') {
      this.touch(originId, tmuxSession, timestamp);
      return;
    }
    this.clear(originId, tmuxSession);
  }

  /**
   * Remove and return all sessions with last activity at or before `cutoff`.
   */
  consumeExpired(cutoff: number): ExpiredRemoteSession[] {
    const expired: ExpiredRemoteSession[] = [];

    for (const [originId, sessions] of this.byOrigin.entries()) {
      for (const [tmuxSession, lastActivity] of sessions.entries()) {
        if (lastActivity <= cutoff) {
          sessions.delete(tmuxSession);
          expired.push({ originId, tmuxSession, lastActivity });
        }
      }
      if (sessions.size === 0) {
        this.byOrigin.delete(originId);
      }
    }

    return expired;
  }

  has(originId: string, tmuxSession: string): boolean {
    return this.byOrigin.get(originId)?.has(tmuxSession) ?? false;
  }

  getStats(): RemoteWorkingSessionTrackerStats {
    let sessionCount = 0;
    for (const sessions of this.byOrigin.values()) {
      sessionCount += sessions.size;
    }
    return {
      originCount: this.byOrigin.size,
      sessionCount,
    };
  }
}
