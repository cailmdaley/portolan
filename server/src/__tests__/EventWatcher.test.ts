import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventWatcher } from '../EventWatcher.js';

interface TestEventInput {
  tmuxSession: string;
  type: string;
  timestamp: number;
  tool?: string;
  prompt?: string;
}

function makeEvent(input: TestEventInput): Record<string, unknown> {
  return {
    id: `${input.tmuxSession}-${input.type}-${input.timestamp}`,
    timestamp: input.timestamp,
    type: input.type,
    sessionId: `${input.tmuxSession}-session`,
    cwd: '/tmp/project',
    tmuxSession: input.tmuxSession,
    tool: input.tool,
    prompt: input.prompt,
  };
}

function processEvent(watcher: EventWatcher, event: Record<string, unknown>): void {
  (watcher as any).processEvent(event);
}

function processWorkingAndIdle(watcher: EventWatcher, tmuxSession: string, startTs: number): void {
  processEvent(watcher, makeEvent({
    tmuxSession,
    type: 'pre_tool_use',
    timestamp: startTs,
    tool: 'Read',
  }));
  processEvent(watcher, makeEvent({
    tmuxSession,
    type: 'stop',
    timestamp: startTs + 100,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventWatcher session-state ownership', () => {
  it('clears working-timeout ownership immediately on idle events', () => {
    const watcher = new EventWatcher('/tmp/nonexistent-events.jsonl');
    const internals = watcher as any;

    processEvent(watcher, makeEvent({
      tmuxSession: 'alpha',
      type: 'pre_tool_use',
      timestamp: 1_000,
      tool: 'Read',
    }));
    expect(internals.lastActivityBySession.has('alpha')).toBe(true);

    processEvent(watcher, makeEvent({
      tmuxSession: 'alpha',
      type: 'stop',
      timestamp: 1_500,
    }));
    expect(internals.lastActivityBySession.has('alpha')).toBe(false);
  });

  it('bounds idle tracked sessions by maxTrackedSessions', () => {
    const watcher = new EventWatcher('/tmp/nonexistent-events.jsonl', {
      maxTrackedSessions: 2,
      inactiveSessionRetentionMs: Number.MAX_SAFE_INTEGER,
    });
    const internals = watcher as any;

    processWorkingAndIdle(watcher, 'alpha', 1_000);
    processWorkingAndIdle(watcher, 'beta', 2_000);
    processWorkingAndIdle(watcher, 'gamma', 3_000);

    expect(internals.sessionLastSeenAt.size).toBeLessThanOrEqual(2);
    expect(watcher.getRecentActivities('alpha')).toHaveLength(0);
    expect(watcher.getRecentActivities('beta').length).toBeGreaterThan(0);
    expect(watcher.getRecentActivities('gamma').length).toBeGreaterThan(0);
  });

  it('reconciles stale sessions against active tmux ownership', () => {
    const watcher = new EventWatcher('/tmp/nonexistent-events.jsonl');
    const internals = watcher as any;

    processEvent(watcher, makeEvent({
      tmuxSession: 'keep',
      type: 'pre_tool_use',
      timestamp: 1_000,
      tool: 'Read',
    }));
    processEvent(watcher, makeEvent({
      tmuxSession: 'drop',
      type: 'pre_tool_use',
      timestamp: 2_000,
      tool: 'Edit',
    }));

    watcher.reconcileActiveSessions(['keep']);

    expect(watcher.getRecentActivities('keep').length).toBeGreaterThan(0);
    expect(internals.lastActivityBySession.has('keep')).toBe(true);
    expect(internals.sessionLastSeenAt.has('keep')).toBe(true);

    expect(watcher.getRecentActivities('drop')).toHaveLength(0);
    expect(internals.lastActivityBySession.has('drop')).toBe(false);
    expect(internals.sessionLastSeenAt.has('drop')).toBe(false);
  });

  it('prunes inactive idle sessions by retention window', () => {
    const watcher = new EventWatcher('/tmp/nonexistent-events.jsonl', {
      inactiveSessionRetentionMs: 1_000,
      maxTrackedSessions: 10,
    });
    const internals = watcher as any;

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_500);
    processWorkingAndIdle(watcher, 'old-session', 1_000);
    expect(watcher.getRecentActivities('old-session').length).toBeGreaterThan(0);

    nowSpy.mockReturnValue(2_600);
    internals.checkWorkingTimeouts();

    expect(watcher.getRecentActivities('old-session')).toHaveLength(0);
    expect(internals.sessionLastSeenAt.has('old-session')).toBe(false);
  });

  it('reports compact stats for runtime diagnostics', () => {
    const watcher = new EventWatcher('/tmp/nonexistent-events.jsonl');
    processEvent(watcher, makeEvent({
      tmuxSession: 'alpha',
      type: 'pre_tool_use',
      timestamp: 1_000,
      tool: 'Read',
    }));

    const stats = watcher.getStats();
    expect(stats.eventsFile).toBe('/tmp/nonexistent-events.jsonl');
    expect(stats.watcherActive).toBe(false);
    expect(stats.pollIntervalActive).toBe(false);
    expect(stats.timeoutCheckIntervalActive).toBe(false);
    expect(stats.workingSessionCount).toBe(1);
    expect(stats.recentActivitySessionCount).toBe(1);
    expect(stats.totalRecentActivities).toBe(1);
    expect(stats.trackedSessionCount).toBe(1);
  });
});
