/**
 * EventWatcher - Watches portolan events file to track session activity
 *
 * Reads from ~/.portolan/data/events.jsonl (written by portolan-hook.sh)
 * and updates session status based on events like:
 *   - user_prompt_submit, pre_tool_use → 'working'
 *   - stop, session_end → 'idle'
 */

import { readFileSync, writeFileSync, statSync, existsSync, watch } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionTracker } from './SessionTracker.js';
import {
  ActivityEvent,
  EventWatcherSessionState,
  EventWatcherSessionStateOptions,
  EventWatcherSessionStateStats,
  PortolanEvent,
} from './EventWatcherSessionState.js';

type StatusChangeCallback = (tmuxSession: string, status: 'idle' | 'working') => void;
type ActivityCallback = (activity: ActivityEvent) => void;

interface EventWatcherOptions extends EventWatcherSessionStateOptions {}

export interface EventWatcherStats extends EventWatcherSessionStateStats {
  eventsFile: string;
  watcherActive: boolean;
  pollIntervalActive: boolean;
  timeoutCheckIntervalActive: boolean;
}

export class EventWatcher {
  private eventsFile: string;
  private lastFileSize: number = 0;
  private lastCharPosition: number = 0;  // Track character position, not bytes
  private pollInterval: NodeJS.Timeout | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private changeCallback: StatusChangeCallback | null = null;
  private activityCallback: ActivityCallback | null = null;
  private sessionTracker: SessionTracker | null = null;
  private timeoutCheckInterval: NodeJS.Timeout | null = null;
  private sessionState: EventWatcherSessionState;

  constructor(eventsFile?: string, options: EventWatcherOptions = {}) {
    this.eventsFile = eventsFile ?? join(homedir(), '.portolan', 'data', 'events.jsonl');
    this.sessionState = new EventWatcherSessionState(options);
  }

  /**
   * Set callback for status changes (alternative to setSessionTracker)
   */
  onStatusChange(callback: StatusChangeCallback): void {
    this.changeCallback = callback;
  }

  /**
   * Set callback for activity events
   */
  onActivity(callback: ActivityCallback): void {
    this.activityCallback = callback;
  }

  /**
   * Set session tracker to update directly
   */
  setSessionTracker(tracker: SessionTracker): void {
    this.sessionTracker = tracker;
  }

  /**
   * Get recent activities for a tmux session
   */
  getRecentActivities(tmuxSession: string): ActivityEvent[] {
    return this.sessionState.getRecentActivities(tmuxSession);
  }

  /**
   * Return compact runtime stats for diagnostics/debug endpoints.
   */
  getStats(): EventWatcherStats {
    return {
      eventsFile: this.eventsFile,
      watcherActive: this.watcher !== null,
      pollIntervalActive: this.pollInterval !== null,
      timeoutCheckIntervalActive: this.timeoutCheckInterval !== null,
      ...this.sessionState.getStats(),
    };
  }

  /**
   * Remove all cached state for sessions that are no longer active.
   */
  reconcileActiveSessions(activeTmuxSessions: Iterable<string>): void {
    this.sessionState.reconcileActiveSessions(activeTmuxSessions);
  }

  /**
   * Start watching the events file
   */
  start(): void {
    if (!existsSync(this.eventsFile)) {
      console.log(`EventWatcher: Events file not found: ${this.eventsFile}`);
      console.log('EventWatcher: Status detection disabled. Install portolan-hook.sh to enable.');
      return;
    }

    // Truncate if too large (keep last 10k lines)
    this.truncateIfNeeded(10000);

    // Get initial file size and character position
    try {
      const stats = statSync(this.eventsFile);
      this.lastFileSize = stats.size;
      // Read file to get character length (differs from byte length for UTF-8)
      const content = readFileSync(this.eventsFile, 'utf-8');
      this.lastCharPosition = content.length;
    } catch {
      this.lastFileSize = 0;
      this.lastCharPosition = 0;
    }

    // Process recent events to get initial state
    this.processRecentEvents();

    // Watch for file changes
    try {
      this.watcher = watch(this.eventsFile, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.processNewEvents();
        }
      });
    } catch (err) {
      console.error('EventWatcher: Failed to watch events file:', err);
    }

    // Also poll periodically (fallback for systems where watch is unreliable)
    this.pollInterval = setInterval(() => {
      this.processNewEvents();
    }, 1000);

    // Check for working timeout
    this.timeoutCheckInterval = setInterval(() => {
      this.checkWorkingTimeouts();
    }, 5000);

    console.log(`EventWatcher: Watching ${this.eventsFile}`);
  }

  /**
   * Truncate events file if it exceeds maxLines
   */
  private truncateIfNeeded(maxLines: number): void {
    try {
      const content = readFileSync(this.eventsFile, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > maxLines) {
        const kept = lines.slice(-maxLines);
        writeFileSync(this.eventsFile, kept.join('\n') + '\n');
        console.log(`EventWatcher: Truncated ${lines.length} → ${maxLines} lines`);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.timeoutCheckInterval) {
      clearInterval(this.timeoutCheckInterval);
      this.timeoutCheckInterval = null;
    }
  }

  /**
   * Process recent events (last 1000 lines) for initial state
   */
  private processRecentEvents(): void {
    try {
      const content = readFileSync(this.eventsFile, 'utf-8');
      const lines = content.trim().split('\n').slice(-1000);

      // Track most recent status per tmux session
      const events: PortolanEvent[] = [];

      for (const line of lines) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as PortolanEvent;
          events.push(event);
        } catch {
          // Skip malformed lines
        }
      }

      this.sessionState.backfillFromEvents(events, this.updateStatus.bind(this));
    } catch (err) {
      console.error('EventWatcher: Failed to process recent events:', err);
    }
  }

  /**
   * Process new events since last read
   */
  private processNewEvents(): void {
    try {
      const stats = statSync(this.eventsFile);
      if (stats.size <= this.lastFileSize) {
        return; // No new data
      }

      // Read entire file and slice by character position (not bytes)
      const content = readFileSync(this.eventsFile, 'utf-8');
      if (content.length <= this.lastCharPosition) {
        this.lastFileSize = stats.size;
        return;
      }

      const newContent = content.slice(this.lastCharPosition);
      this.lastCharPosition = content.length;
      this.lastFileSize = stats.size;

      const lines = newContent.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as PortolanEvent;
          this.processEvent(event);
        } catch (err) {
          console.log(`EventWatcher: Parse error on line: ${line.substring(0, 50)}... Error: ${err}`);
        }
      }
    } catch {
      // File may have been truncated or rotated
      try {
        const stats = statSync(this.eventsFile);
        this.lastFileSize = stats.size;
      } catch {
        this.lastFileSize = 0;
      }
    }
  }

  /**
   * Process a single event
   */
  private processEvent(event: PortolanEvent): void {
    const activity = this.sessionState.processEvent(event, this.updateStatus.bind(this));
    if (activity && this.activityCallback) {
      this.activityCallback(activity);
    }
  }

  /**
   * Check for sessions that have been 'working' too long without activity
   */
  private checkWorkingTimeouts(): void {
    this.sessionState.checkWorkingTimeouts(this.updateStatus.bind(this));
  }

  /**
   * Update status via callback or tracker
   */
  private updateStatus(tmuxSession: string, status: 'idle' | 'working'): void {
    if (this.sessionTracker) {
      this.sessionTracker.updateStatus(tmuxSession, status);
    }
    if (this.changeCallback) {
      this.changeCallback(tmuxSession, status);
    }
  }

  private getDebugState(): {
    lastActivityBySession: Map<string, number>;
    sessionLastSeenAt: Map<string, number>;
  } {
    return this.sessionState.getDebugState();
  }
}
