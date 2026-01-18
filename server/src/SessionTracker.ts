/**
 * SessionTracker - Discovers and tracks tmux sessions running Claude
 *
 * Polls tmux every N seconds to discover sessions running Claude.
 * This is the source of truth for sessions - derived from tmux state.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface Session {
  id: string;
  name: string;
  tmuxSession: string;
  cwd: string;
  cityId?: string | null;
  workerHex?: { q: number; r: number };
  status: 'idle' | 'working' | 'offline';
  createdAt: number;
  lastActivity: number;
  originId: string;  // 'local' | 'remote-{hostname}'
}

type SessionsChangeCallback = (sessions: Session[]) => void;

export class SessionTracker {
  private sessions: Map<string, Session> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private changeCallbacks: SessionsChangeCallback[] = [];

  /**
   * Start polling tmux for sessions
   */
  start(intervalMs: number = 2000): void {
    if (this.pollInterval) {
      return;
    }

    // Initial discovery
    this.refresh();

    // Poll on interval
    this.pollInterval = setInterval(() => {
      this.refresh();
    }, intervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Register callback for session changes
   */
  onSessionsChange(callback: SessionsChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Get all sessions
   */
  getSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Discover sessions from tmux
   */
  private async refresh(): Promise<void> {
    try {
      const discovered = await this.discoverSessions();
      const discoveredMap = new Map<string, { tmuxSession: string; cwd: string }>();

      for (const { tmuxSession, cwd } of discovered) {
        discoveredMap.set(tmuxSession, { tmuxSession, cwd });
      }

      let changed = false;

      // Remove sessions that no longer exist
      for (const [tmuxSession, session] of this.sessions) {
        if (!discoveredMap.has(tmuxSession)) {
          this.sessions.delete(tmuxSession);
          changed = true;
        }
      }

      // Add or update sessions
      for (const { tmuxSession, cwd } of discovered) {
        const existing = this.sessions.get(tmuxSession);

        if (existing) {
          // Update cwd if changed
          if (existing.cwd !== cwd) {
            existing.cwd = cwd;
            existing.cityId = null; // Will be reassigned by index.ts
            changed = true;
          }
          // Ensure not offline
          if (existing.status === 'offline') {
            existing.status = 'idle';
            changed = true;
          }
        } else {
          // New session
          const session: Session = {
            id: this.generateId(tmuxSession),
            name: tmuxSession,
            tmuxSession,
            cwd,
            status: 'idle',
            createdAt: Date.now(),
            lastActivity: Date.now(),
            originId: 'local',
          };
          this.sessions.set(tmuxSession, session);
          changed = true;
        }
      }

      // Notify listeners if changed
      if (changed) {
        this.notifyChange();
      }
    } catch (error) {
      console.error('Session refresh failed:', error);
    }
  }

  /**
   * Discover all tmux sessions running Claude
   */
  private async discoverSessions(): Promise<Array<{ tmuxSession: string; cwd: string }>> {
    try {
      // Get all tmux panes with session name, cwd, and pane PID
      const { stdout } = await execAsync(
        'tmux list-panes -a -F "#{session_name}\t#{pane_current_path}\t#{pane_pid}"'
      );

      const lines = stdout.trim().split('\n').filter(Boolean);
      const paneData: Array<{ tmuxSession: string; cwd: string; panePid: string }> = [];

      for (const line of lines) {
        const [tmuxSession, cwd, panePid] = line.split('\t');
        if (panePid) {
          paneData.push({ tmuxSession, cwd: cwd || process.cwd(), panePid });
        }
      }

      if (paneData.length === 0) {
        return [];
      }

      // Check which panes have claude running
      const claudeSessions: Array<{ tmuxSession: string; cwd: string }> = [];

      for (const { tmuxSession, cwd, panePid } of paneData) {
        try {
          const { stdout: pgrepOut } = await execAsync(
            `pgrep -P ${panePid} -f claude 2>/dev/null || true`
          );
          if (pgrepOut.trim()) {
            claudeSessions.push({ tmuxSession, cwd });
          }
        } catch {
          // Ignore errors from pgrep
        }
      }

      return claudeSessions;
    } catch {
      // tmux not running or error
      return [];
    }
  }

  /**
   * Generate stable session ID from tmux session name
   */
  private generateId(tmuxSession: string): string {
    // Use simple hash of tmux session name for stable ID
    let hash = 0;
    for (let i = 0; i < tmuxSession.length; i++) {
      const char = tmuxSession.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `session-${Math.abs(hash).toString(36)}`;
  }

  /**
   * Notify listeners of session changes
   */
  private notifyChange(): void {
    const sessions = this.getSessions();
    for (const callback of this.changeCallbacks) {
      callback(sessions);
    }
  }
}
