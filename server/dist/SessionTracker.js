/**
 * SessionTracker - Discovers and tracks tmux sessions running Claude
 *
 * Polls tmux every N seconds to discover sessions running Claude.
 * This is the source of truth for sessions - derived from tmux state.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
export class SessionTracker {
    sessions = new Map();
    pollInterval = null;
    changeCallbacks = [];
    /**
     * Start polling tmux for sessions
     */
    start(intervalMs = 2000) {
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
    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
    /**
     * Register callback for session changes
     */
    onSessionsChange(callback) {
        this.changeCallbacks.push(callback);
    }
    /**
     * Get all sessions
     */
    getSessions() {
        return Array.from(this.sessions.values());
    }
    /**
     * Discover sessions from tmux
     */
    async refresh() {
        try {
            const discovered = await this.discoverSessions();
            const discoveredMap = new Map();
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
                }
                else {
                    // New session
                    const session = {
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
        }
        catch (error) {
            console.error('Session refresh failed:', error);
        }
    }
    /**
     * Discover all tmux sessions running Claude
     */
    async discoverSessions() {
        try {
            // Get all tmux panes with session name, cwd, and pane PID
            const { stdout } = await execAsync('tmux list-panes -a -F "#{session_name}\t#{pane_current_path}\t#{pane_pid}"');
            const lines = stdout.trim().split('\n').filter(Boolean);
            const paneData = [];
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
            const claudeSessions = [];
            for (const { tmuxSession, cwd, panePid } of paneData) {
                try {
                    const { stdout: pgrepOut } = await execAsync(`pgrep -P ${panePid} -f claude 2>/dev/null || true`);
                    if (pgrepOut.trim()) {
                        claudeSessions.push({ tmuxSession, cwd });
                    }
                }
                catch {
                    // Ignore errors from pgrep
                }
            }
            return claudeSessions;
        }
        catch {
            // tmux not running or error
            return [];
        }
    }
    /**
     * Generate stable session ID from tmux session name
     */
    generateId(tmuxSession) {
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
    notifyChange() {
        const sessions = this.getSessions();
        for (const callback of this.changeCallbacks) {
            callback(sessions);
        }
    }
}
//# sourceMappingURL=SessionTracker.js.map