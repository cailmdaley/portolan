import { extractActivityDetails } from './activityUtils.js';
import type { PortolanEvent } from './PortolanEventNormalizer.js';

export type { PortolanEvent } from './PortolanEventNormalizer.js';

export interface ActivityEvent {
  tmuxSession: string;
  tool: string;
  summary?: string;
  fullPath?: string;
  timestamp: number;
  eventType?: 'tool' | 'user_prompt';
  prompt?: string;
  sessionId?: string;
}

export interface EventWatcherSessionStateOptions {
  workingTimeoutMs?: number;
  maxActivitiesPerSession?: number;
  maxTrackedSessions?: number;
  inactiveSessionRetentionMs?: number;
}

export interface EventWatcherSessionStateStats {
  workingTimeoutMs: number;
  maxActivitiesPerSession: number;
  maxTrackedSessions: number;
  inactiveSessionRetentionMs: number;
  workingSessionCount: number;
  recentActivitySessionCount: number;
  totalRecentActivities: number;
  trackedSessionCount: number;
}

type StatusUpdater = (tmuxSession: string, status: 'idle' | 'working') => void;

export class EventWatcherSessionState {
  private workingTimeout = 30_000;
  private lastActivityBySession: Map<string, number> = new Map();
  private recentActivities: Map<string, ActivityEvent[]> = new Map();
  private maxActivitiesPerSession = 50;
  private maxTrackedSessions = 500;
  private inactiveSessionRetentionMs = 15 * 60_000;
  private sessionLastSeenAt: Map<string, number> = new Map();

  constructor(options: EventWatcherSessionStateOptions = {}) {
    if (options.workingTimeoutMs !== undefined) {
      this.workingTimeout = options.workingTimeoutMs;
    }
    if (options.maxActivitiesPerSession !== undefined) {
      this.maxActivitiesPerSession = options.maxActivitiesPerSession;
    }
    if (options.maxTrackedSessions !== undefined) {
      this.maxTrackedSessions = options.maxTrackedSessions;
    }
    if (options.inactiveSessionRetentionMs !== undefined) {
      this.inactiveSessionRetentionMs = options.inactiveSessionRetentionMs;
    }
  }

  getRecentActivities(tmuxSession: string): ActivityEvent[] {
    return this.recentActivities.get(tmuxSession) || [];
  }

  getStats(): EventWatcherSessionStateStats {
    let totalRecentActivities = 0;
    for (const activities of this.recentActivities.values()) {
      totalRecentActivities += activities.length;
    }

    return {
      workingTimeoutMs: this.workingTimeout,
      maxActivitiesPerSession: this.maxActivitiesPerSession,
      maxTrackedSessions: this.maxTrackedSessions,
      inactiveSessionRetentionMs: this.inactiveSessionRetentionMs,
      workingSessionCount: this.lastActivityBySession.size,
      recentActivitySessionCount: this.recentActivities.size,
      totalRecentActivities,
      trackedSessionCount: this.sessionLastSeenAt.size,
    };
  }

  reconcileActiveSessions(activeTmuxSessions: Iterable<string>): void {
    const active = new Set(activeTmuxSessions);
    const knownSessions = new Set<string>();
    for (const key of this.sessionLastSeenAt.keys()) knownSessions.add(key);
    for (const key of this.recentActivities.keys()) knownSessions.add(key);
    for (const key of this.lastActivityBySession.keys()) knownSessions.add(key);

    for (const tmuxSession of knownSessions) {
      if (!active.has(tmuxSession)) {
        this.deleteSessionState(tmuxSession);
      }
    }
  }

  backfillFromEvents(events: PortolanEvent[], updateStatus: StatusUpdater): void {
    const latestStatus: Map<string, { status: 'idle' | 'working'; timestamp: number }> = new Map();
    const activitiesBySession: Map<string, ActivityEvent[]> = new Map();

    for (const event of events) {
      if (!event.tmuxSession) continue;
      this.markSessionSeen(event.tmuxSession, event.timestamp);

      const status = this.eventToStatus(event.type);
      if (status && event.timestamp > (latestStatus.get(event.tmuxSession)?.timestamp ?? 0)) {
        latestStatus.set(event.tmuxSession, { status, timestamp: event.timestamp });
      }

      const activity = this.createActivityEvent(event);
      if (!activity) continue;

      let activities = activitiesBySession.get(event.tmuxSession);
      if (!activities) {
        activities = [];
        activitiesBySession.set(event.tmuxSession, activities);
      }
      activities.push(activity);
    }

    for (const [tmuxSession, activities] of activitiesBySession) {
      this.recentActivities.set(tmuxSession, activities.slice(-this.maxActivitiesPerSession).reverse());
    }

    const now = Date.now();
    for (const [tmuxSession, { status, timestamp }] of latestStatus) {
      if (status === 'working' && now - timestamp > this.workingTimeout) {
        updateStatus(tmuxSession, 'idle');
        this.lastActivityBySession.delete(tmuxSession);
      } else {
        updateStatus(tmuxSession, status);
        if (status === 'working') {
          this.lastActivityBySession.set(tmuxSession, timestamp);
        } else {
          this.lastActivityBySession.delete(tmuxSession);
        }
      }
    }

    this.pruneInactiveSessionState(now);
  }

  processEvent(event: PortolanEvent, updateStatus: StatusUpdater): ActivityEvent | null {
    if (!event.tmuxSession) return null;
    const eventTimestamp = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
    this.markSessionSeen(event.tmuxSession, eventTimestamp);

    const status = this.eventToStatus(event.type);
    if (status) {
      updateStatus(event.tmuxSession, status);
      if (status === 'working') {
        this.lastActivityBySession.set(event.tmuxSession, eventTimestamp);
      } else {
        this.lastActivityBySession.delete(event.tmuxSession);
      }
    }

    const activity = this.createActivityEvent(event);
    if (activity) {
      this.storeActivity(event.tmuxSession, activity);
    }

    this.pruneInactiveSessionState(Date.now());
    return activity;
  }

  checkWorkingTimeouts(updateStatus: StatusUpdater): void {
    const now = Date.now();
    for (const [tmuxSession, lastActivity] of this.lastActivityBySession) {
      if (now - lastActivity > this.workingTimeout) {
        updateStatus(tmuxSession, 'idle');
        this.lastActivityBySession.delete(tmuxSession);
      }
    }
    this.pruneInactiveSessionState(now);
  }

  getDebugState(): {
    lastActivityBySession: Map<string, number>;
    sessionLastSeenAt: Map<string, number>;
  } {
    return {
      lastActivityBySession: this.lastActivityBySession,
      sessionLastSeenAt: this.sessionLastSeenAt,
    };
  }

  private createActivityEvent(event: PortolanEvent): ActivityEvent | null {
    if ((event.type === 'pre_tool_use' || event.type === 'post_tool_use') && event.tool) {
      const details = extractActivityDetails(event.tool, event.toolInput);
      return {
        tmuxSession: event.tmuxSession,
        tool: event.tool,
        summary: details?.summary,
        fullPath: details?.fullPath,
        timestamp: event.timestamp,
        eventType: 'tool',
        sessionId: event.sessionId,
      };
    }

    if (event.type === 'user_prompt_submit' && event.prompt) {
      return {
        tmuxSession: event.tmuxSession,
        tool: 'UserPrompt',
        summary: event.prompt.length > 100 ? event.prompt.slice(0, 100) + '...' : event.prompt,
        timestamp: event.timestamp,
        eventType: 'user_prompt',
        prompt: event.prompt,
        sessionId: event.sessionId,
      };
    }

    return null;
  }

  private storeActivity(tmuxSession: string, activity: ActivityEvent): void {
    let activities = this.recentActivities.get(tmuxSession);
    if (!activities) {
      activities = [];
      this.recentActivities.set(tmuxSession, activities);
    }

    const recent = activities[0];
    if (
      recent &&
      recent.tool === activity.tool &&
      recent.fullPath === activity.fullPath &&
      Math.abs(recent.timestamp - activity.timestamp) < 2000
    ) {
      return;
    }

    activities.unshift(activity);
    if (activities.length > this.maxActivitiesPerSession) {
      activities.pop();
    }
    this.markSessionSeen(tmuxSession, activity.timestamp);
  }

  private eventToStatus(eventType: string): 'idle' | 'working' | null {
    switch (eventType) {
      case 'user_prompt_submit':
      case 'pre_tool_use':
        return 'working';
      case 'stop':
      case 'subagent_stop':
      case 'session_end':
        return 'idle';
      default:
        return null;
    }
  }

  private markSessionSeen(tmuxSession: string, timestamp: number): void {
    const current = this.sessionLastSeenAt.get(tmuxSession) ?? 0;
    if (timestamp > current) {
      this.sessionLastSeenAt.set(tmuxSession, timestamp);
    }
    this.enforceTrackedSessionLimit();
  }

  private pruneInactiveSessionState(now: number): void {
    const cutoff = now - this.inactiveSessionRetentionMs;
    for (const [tmuxSession, lastSeen] of this.sessionLastSeenAt.entries()) {
      if (lastSeen <= cutoff && !this.lastActivityBySession.has(tmuxSession)) {
        this.deleteSessionState(tmuxSession);
      }
    }
  }

  private enforceTrackedSessionLimit(): void {
    if (this.sessionLastSeenAt.size <= this.maxTrackedSessions) {
      return;
    }

    const removable = Array.from(this.sessionLastSeenAt.entries())
      .filter(([tmuxSession]) => !this.lastActivityBySession.has(tmuxSession))
      .sort((a, b) => a[1] - b[1]);

    for (const [tmuxSession] of removable) {
      if (this.sessionLastSeenAt.size <= this.maxTrackedSessions) {
        break;
      }
      this.deleteSessionState(tmuxSession);
    }
  }

  private deleteSessionState(tmuxSession: string): void {
    this.lastActivityBySession.delete(tmuxSession);
    this.recentActivities.delete(tmuxSession);
    this.sessionLastSeenAt.delete(tmuxSession);
  }
}
