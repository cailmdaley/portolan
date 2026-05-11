import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RecentFileTracker } from '../RecentFileTracker.js';

describe('RecentFileTracker', () => {
  it('keeps the most recent touch and drops the older entry for the same path', () => {
    const tracker = new RecentFileTracker();

    tracker.recordTouch('s1', 'Read', '/p/main.ts', 1000);
    tracker.recordTouch('s1', 'Read', '/p/RecentWorkerBar.ts', 2000);
    // Re-Read main.ts later: should *replace* the earlier entry, not duplicate.
    tracker.recordTouch('s1', 'Read', '/p/main.ts', 3000);

    const files = tracker.getRecentFiles('s1');
    expect(files.map(f => f.fullPath)).toEqual([
      '/p/main.ts',
      '/p/RecentWorkerBar.ts',
    ]);
    expect(files[0].timestamp).toBe(3000);
  });

  it('dedupes across different tool names on the same path', () => {
    // Read-then-Edit on the same file should collapse to one entry — the
    // tooltip wants to show *which files* a worker has been touching, not a
    // chronological tool log.
    const tracker = new RecentFileTracker();

    tracker.recordTouch('s1', 'Read', '/p/foo.ts', 1000);
    tracker.recordTouch('s1', 'Edit', '/p/foo.ts', 2000);

    const files = tracker.getRecentFiles('s1');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ toolName: 'Edit', fullPath: '/p/foo.ts', timestamp: 2000 });
  });

  it('promotes a re-touched file back to the head of the trail', () => {
    const tracker = new RecentFileTracker();

    tracker.recordTouch('s1', 'Read', '/p/a.ts', 1000);
    tracker.recordTouch('s1', 'Read', '/p/b.ts', 2000);
    tracker.recordTouch('s1', 'Read', '/p/c.ts', 3000);
    // Re-touch a.ts: should jump to the head, not append at end.
    tracker.recordTouch('s1', 'Read', '/p/a.ts', 4000);

    expect(tracker.getRecentFiles('s1').map(f => f.fullPath)).toEqual([
      '/p/a.ts',
      '/p/c.ts',
      '/p/b.ts',
    ]);
  });

  it('caps entries per session', () => {
    const tracker = new RecentFileTracker(3);

    for (let i = 0; i < 10; i++) {
      tracker.recordTouch('s1', 'Read', `/p/f${i}.ts`, i);
    }

    const files = tracker.getRecentFiles('s1', 10);
    expect(files).toHaveLength(3);
    expect(files.map(f => f.basename)).toEqual(['f9.ts', 'f8.ts', 'f7.ts']);
  });

  it('isolates trails by session', () => {
    const tracker = new RecentFileTracker();
    tracker.recordTouch('s1', 'Read', '/p/a.ts', 1);
    tracker.recordTouch('s2', 'Read', '/p/b.ts', 2);

    expect(tracker.getRecentFiles('s1').map(f => f.basename)).toEqual(['a.ts']);
    expect(tracker.getRecentFiles('s2').map(f => f.basename)).toEqual(['b.ts']);
  });

  it('ignores empty session id and empty path', () => {
    const tracker = new RecentFileTracker();
    tracker.recordTouch('', 'Read', '/p/a.ts', 1);
    tracker.recordTouch('s1', 'Read', '   ', 2);
    expect(tracker.getSessionCount()).toBe(0);
  });

  it('persists recent files across tracker instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portolan-recent-files-'));
    const path = join(dir, 'recent-files.json');
    try {
      const first = new RecentFileTracker(3, path);
      first.recordTouch('s1', 'Read', '/p/a.ts', 1);
      first.recordTouch('s1', 'Edit', '/p/b.ts', 2);

      const second = new RecentFileTracker(3, path);
      expect(second.getRecentFiles('s1')).toEqual([
        expect.objectContaining({ toolName: 'Edit', fullPath: '/p/b.ts', basename: 'b.ts', timestamp: 2 }),
        expect.objectContaining({ toolName: 'Read', fullPath: '/p/a.ts', basename: 'a.ts', timestamp: 1 }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a session trail when the worker temporarily disappears', () => {
    const tracker = new RecentFileTracker();
    tracker.recordTouch('s1', 'Read', '/p/a.ts', 1);
    tracker.removeSession('s1');
    expect(tracker.getRecentFiles('s1').map(f => f.basename)).toEqual(['a.ts']);
  });
});
