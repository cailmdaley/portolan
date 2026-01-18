/**
 * SessionTracker - Discovers and tracks tmux sessions running Claude
 *
 * Polls tmux every N seconds to discover sessions running Claude.
 * This is the source of truth for sessions - derived from tmux state.
 */
export interface Session {
    id: string;
    name: string;
    tmuxSession: string;
    cwd: string;
    cityId?: string | null;
    workerHex?: {
        q: number;
        r: number;
    };
    status: 'idle' | 'working' | 'offline';
    createdAt: number;
    lastActivity: number;
    originId: string;
}
type SessionsChangeCallback = (sessions: Session[]) => void;
export declare class SessionTracker {
    private sessions;
    private pollInterval;
    private changeCallbacks;
    /**
     * Start polling tmux for sessions
     */
    start(intervalMs?: number): void;
    /**
     * Stop polling
     */
    stop(): void;
    /**
     * Register callback for session changes
     */
    onSessionsChange(callback: SessionsChangeCallback): void;
    /**
     * Get all sessions
     */
    getSessions(): Session[];
    /**
     * Discover sessions from tmux
     */
    private refresh;
    /**
     * Discover all tmux sessions running Claude
     */
    private discoverSessions;
    /**
     * Generate stable session ID from tmux session name
     */
    private generateId;
    /**
     * Notify listeners of session changes
     */
    private notifyChange;
}
export {};
//# sourceMappingURL=SessionTracker.d.ts.map