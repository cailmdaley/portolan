import { describe, expect, it } from 'vitest';
import { EventWatcher } from '../EventWatcher.js';
import { HttpApiHooksRuntime } from '../HttpApiHooksRuntime.js';
import { RecentFileTracker } from '../RecentFileTracker.js';

describe('multi-harness recent-file smoke', () => {
  it('feeds Claude Code, Codex, and Pi file events through /recent-files', async () => {
    const watcher = new EventWatcher('/tmp/nonexistent-events.jsonl');
    const tracker = new RecentFileTracker();
    const tmuxToWorkerId = new Map([
      ['claude-worker', 'session-claude-worker'],
      ['codex-worker', 'session-codex-worker'],
      ['pi-worker', 'session-pi-worker'],
    ]);

    watcher.onActivity((activity) => {
      if (!activity.fullPath) return;
      const workerId = tmuxToWorkerId.get(activity.tmuxSession);
      if (workerId) {
        tracker.recordTouch(workerId, activity.tool, activity.fullPath, activity.timestamp);
      }
    });

    const events = [
      ['claude-code', 'claude-worker', 'Read', '/project/claude.md'],
      ['codex', 'codex-worker', 'Edit', '/project/codex.ts'],
      ['pi', 'pi-worker', 'Write', '/project/pi.txt'],
    ] as const;

    events.forEach(([harness, tmuxSession, tool, filePath], index) => {
      (watcher as any).processEvent({
        id: `${harness}-${index}`,
        timestamp: 1_000 + index,
        type: 'post_tool_use',
        sessionId: `${harness}-session`,
        cwd: '/project',
        tmuxSession,
        harness,
        tool,
        toolInput: { file_path: filePath },
      });
    });

    const api = new HttpApiHooksRuntime({
      parseJsonBody: async () => null,
      sendJsonError: (res, status, error) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error }));
      },
      sendJsonSuccess: (res, data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      },
    });
    api.setRecentFileTracker(tracker);

    for (const [, , , filePath] of events) {
      const basename = filePath.split('/').pop();
      const sessionId = `session-${basename?.split('.')[0]}-worker`;
      const body = await recentFiles(api, sessionId);
      expect(body.files).toEqual([
        expect.objectContaining({ basename }),
      ]);
    }
  });
});

async function recentFiles(api: HttpApiHooksRuntime, sessionId: string): Promise<any> {
  let body = '';
  const res = {
    writeHead: () => res,
    end: (chunk: string) => {
      body = chunk;
      return res;
    },
  } as any;

  await api.handleRecentFiles(new URL(`http://localhost/recent-files?sessionId=${sessionId}`), res);
  return JSON.parse(body);
}
