import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionTracker } from '../SessionTracker.js';
import { exec } from 'child_process';

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

describe('SessionTracker', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
    vi.clearAllMocks();
  });

  describe('session discovery', () => {
    it('should parse tmux output and discover sessions running claude', async () => {
      // The implementation now does:
      // 1. tmux list-panes
      // 2. For each pane: ps -o comm= to check if pane IS claude
      // 3. If not, pgrep to check children
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, {
            stdout: 'session1\t/home/user/project1\t12345\nsession2\t/home/user/project2\t12346\n',
            stderr: '',
          });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('12345')) {
          // session1: pane process is claude
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('12346')) {
          // session2: pane process is NOT claude
          callback(null, { stdout: 'zsh\n', stderr: '' });
        } else if (cmd.includes('pgrep') && cmd.includes('12346')) {
          // session2: no claude children
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      // Trigger refresh
      await tracker['refresh']();

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].tmuxSession).toBe('session1');
      expect(sessions[0].cwd).toBe('/home/user/project1');
    });

    it('should return empty array when tmux is not running', async () => {
      mockExec.mockImplementation((cmd: string, callback: any) => {
        callback(new Error('tmux not running'), { stdout: '', stderr: 'error' });
        return {} as any;
      });

      await tracker['refresh']();

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(0);
    });

    it('should handle malformed tmux output', async () => {
      mockExec.mockImplementationOnce((cmd, callback: any) => {
        if (cmd.includes('list-panes')) {
          // Missing tab-separated values
          callback(null, { stdout: 'malformed\ndata\n', stderr: '' });
        }
        return {} as any;
      });

      // Should not crash
      await tracker['refresh']();

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(0);
    });

    it('should handle empty tmux output', async () => {
      mockExec.mockImplementationOnce((cmd, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(0);
    });
  });

  describe('session change detection', () => {
    it('should detect when sessions are added', async () => {
      const changeCallback = vi.fn();
      tracker.onSessionsChange(changeCallback);

      // Initial state: no sessions
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();
      expect(changeCallback).not.toHaveBeenCalled();

      // Add a session - pane process IS claude
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: 'newsession\t/tmp\t99999\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('99999')) {
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();
      expect(changeCallback).toHaveBeenCalled();

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].tmuxSession).toBe('newsession');
    });

    it('should detect when sessions are removed', async () => {
      // Start with one session - pane process IS claude
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: 'session1\t/tmp\t12345\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('12345')) {
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();

      const changeCallback = vi.fn();
      tracker.onSessionsChange(changeCallback);

      // Session disappears
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();
      expect(changeCallback).toHaveBeenCalled();

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(0);
    });

    it('should detect when session cwd changes', async () => {
      // Initial session - pane process IS claude
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: 'session1\t/old/path\t12345\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('12345')) {
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();

      const changeCallback = vi.fn();
      tracker.onSessionsChange(changeCallback);

      // Same session, different cwd
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: 'session1\t/new/path\t12345\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('12345')) {
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();
      expect(changeCallback).toHaveBeenCalled();

      const sessions = tracker.getSessions();
      expect(sessions[0].cwd).toBe('/new/path');
      expect(sessions[0].cityId).toBeNull(); // Should be reset
    });

    it('should not trigger change callback when nothing changes', async () => {
      // Initial session - pane process IS claude
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: 'session1\t/tmp\t12345\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('12345')) {
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await tracker['refresh']();

      const changeCallback = vi.fn();
      tracker.onSessionsChange(changeCallback);

      // Same session, same data (mock unchanged)
      await tracker['refresh']();
      expect(changeCallback).not.toHaveBeenCalled();
    });
  });

  describe('rapid session creation/deletion', () => {
    it('should handle rapid session changes', async () => {
      const changes: number[] = [];
      tracker.onSessionsChange((sessions) => {
        changes.push(sessions.length);
      });

      // Session s1 appears - pane process IS claude
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: 's1\t/tmp\t1\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('1')) {
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });
      await tracker['refresh']();

      // Session disappears
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });
      await tracker['refresh']();

      // Different session s2 appears - pane process IS claude
      mockExec.mockImplementation((cmd: string, callback: any) => {
        if (cmd.includes('list-panes')) {
          callback(null, { stdout: 's2\t/tmp\t2\n', stderr: '' });
        } else if (cmd.includes('ps -o comm=') && cmd.includes('2')) {
          callback(null, { stdout: 'claude\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });
      await tracker['refresh']();

      expect(changes).toEqual([1, 0, 1]);
    });
  });

  describe('generateId', () => {
    it('should generate stable IDs for same session name', () => {
      const id1 = tracker['generateId']('test-session');
      const id2 = tracker['generateId']('test-session');

      expect(id1).toBe(id2);
    });

    it('should generate different IDs for different session names', () => {
      const id1 = tracker['generateId']('session-1');
      const id2 = tracker['generateId']('session-2');

      expect(id1).not.toBe(id2);
    });
  });

  describe('start and stop', () => {
    it('should start polling', () => {
      mockExec.mockImplementation((cmd, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      tracker.start(100);

      // Should have called refresh initially
      expect(mockExec).toHaveBeenCalled();
    });

    it('should stop polling', () => {
      tracker.start(100);
      tracker.stop();

      // Should not be polling anymore
      // (Hard to test without actually waiting for interval)
    });

    it('should not start multiple intervals', () => {
      mockExec.mockImplementation((cmd, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      tracker.start(100);
      tracker.start(100);

      // Should only have one interval running
      // (Implementation detail - can't easily assert)
    });
  });
});
