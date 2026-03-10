import { describe, expect, it } from 'vitest';
import { RemoteWorkingSessionTracker } from '../RemoteWorkingSessionTracker.js';

describe('RemoteWorkingSessionTracker', () => {
  it('tracks and clears sessions by explicit origin/session keys', () => {
    const tracker = new RemoteWorkingSessionTracker();
    tracker.touch('origin-a', 'alpha', 1000);

    expect(tracker.has('origin-a', 'alpha')).toBe(true);

    tracker.clear('origin-a', 'alpha');
    expect(tracker.has('origin-a', 'alpha')).toBe(false);
  });

  it('reconciles status transitions', () => {
    const tracker = new RemoteWorkingSessionTracker();

    tracker.reconcile('origin-a', 'alpha', 'working', 1000);
    expect(tracker.has('origin-a', 'alpha')).toBe(true);

    tracker.reconcile('origin-a', 'alpha', 'idle', 2000);
    expect(tracker.has('origin-a', 'alpha')).toBe(false);
  });

  it('consumes only sessions at or before cutoff and keeps others', () => {
    const tracker = new RemoteWorkingSessionTracker();
    tracker.touch('origin-a', 'stale', 1000);
    tracker.touch('origin-a', 'fresh', 5000);
    tracker.touch('origin-b', 'also-stale', 1500);

    const expired = tracker.consumeExpired(2000);
    const keys = new Set(expired.map(e => `${e.originId}:${e.tmuxSession}:${e.lastActivity}`));

    expect(keys).toEqual(new Set([
      'origin-a:stale:1000',
      'origin-b:also-stale:1500',
    ]));
    expect(tracker.has('origin-a', 'fresh')).toBe(true);
    expect(tracker.has('origin-a', 'stale')).toBe(false);
    expect(tracker.has('origin-b', 'also-stale')).toBe(false);
  });

  it('handles tmux session names containing colons without ambiguity', () => {
    const tracker = new RemoteWorkingSessionTracker();
    tracker.touch('origin-a', 'worker:42', 1000);
    tracker.touch('origin-a', 'worker:99', 3000);

    const expired = tracker.consumeExpired(1500);

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      originId: 'origin-a',
      tmuxSession: 'worker:42',
      lastActivity: 1000,
    });
    expect(tracker.has('origin-a', 'worker:42')).toBe(false);
    expect(tracker.has('origin-a', 'worker:99')).toBe(true);
  });

  it('clears all sessions for an origin', () => {
    const tracker = new RemoteWorkingSessionTracker();
    tracker.touch('origin-a', 'a1', 1000);
    tracker.touch('origin-a', 'a2', 1000);
    tracker.touch('origin-b', 'b1', 1000);

    tracker.clearOrigin('origin-a');

    expect(tracker.has('origin-a', 'a1')).toBe(false);
    expect(tracker.has('origin-a', 'a2')).toBe(false);
    expect(tracker.has('origin-b', 'b1')).toBe(true);
  });

  it('reports aggregate stats for runtime diagnostics', () => {
    const tracker = new RemoteWorkingSessionTracker();
    tracker.touch('origin-a', 'a1', 1000);
    tracker.touch('origin-a', 'a2', 1000);
    tracker.touch('origin-b', 'b1', 1000);

    expect(tracker.getStats()).toEqual({
      originCount: 2,
      sessionCount: 3,
    });
  });
});
