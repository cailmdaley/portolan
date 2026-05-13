import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'child_process';
import { TmuxSessionMessenger } from '../TmuxSessionMessenger.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
  execFileSync: vi.fn(() => Buffer.from('')),
}));

const mockExecSync = childProcess.execSync as unknown as ReturnType<typeof vi.fn>;
const mockExecFileSync = childProcess.execFileSync as unknown as ReturnType<typeof vi.fn>;

const LONG_MULTILINE_ANNOTATION = [
  '',
  '# Feedback on .felt/ai-futures/application/anthropic-stem-fellowship/drafts/drafts.md',
  '',
  "I've reviewed this file and have 1 piece of feedback:",
  '',
  '## 1. (L42-L88) Feedback on: "Observational cosmology has converged..."',
  '> One long paragraph that wraps across many lines and contains',
  '> embedded newlines so the receiving worker would interpret each',
  '> newline as an Enter keypress unless the paste arrives bracketed.',
  '> Without bracketed paste the user only sees the trailing chunk.',
  '',
  '---',
].join('\n');

describe('TmuxSessionMessenger', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from(''));
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
  });

  // Regression: long multi-paragraph annotations were arriving at the worker
  // truncated to just the final paragraph + trailing `---`. Cause: tmux
  // paste-buffer without `-p` feeds embedded newlines as raw Enter
  // keypresses, fragmenting the message into many submits. Bracketed paste
  // makes the whole content arrive as a single input event.
  describe('bracketed paste (regression: long annotation truncation)', () => {
    it('uses paste-buffer -p for local sessions', () => {
      const messenger = new TmuxSessionMessenger();

      messenger.send({ tmuxSession: 'worker-1' }, LONG_MULTILINE_ANNOTATION);

      const pasteCall = mockExecSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd.startsWith('tmux paste-buffer'),
      );
      expect(pasteCall, 'expected a paste-buffer invocation').toBeDefined();
      expect(pasteCall![0]).toMatch(/tmux paste-buffer\s+-p\s/);
    });

    it('uses paste-buffer -p for remote sessions', () => {
      const messenger = new TmuxSessionMessenger();

      messenger.send(
        { tmuxSession: 'worker-1', sshHost: 'candide' },
        LONG_MULTILINE_ANNOTATION,
      );

      const pasteCall = mockExecFileSync.mock.calls.find(([bin, args]) => {
        if (bin !== 'ssh' || !Array.isArray(args)) return false;
        return typeof args[1] === 'string' && args[1].startsWith('tmux paste-buffer');
      });
      expect(pasteCall, 'expected a remote paste-buffer invocation').toBeDefined();
      const remoteCmd = (pasteCall![1] as string[])[1];
      expect(remoteCmd).toMatch(/tmux paste-buffer\s+-p\s/);
    });

    it('still loads the full message into the tmux buffer (newlines preserved)', () => {
      const messenger = new TmuxSessionMessenger();

      messenger.send({ tmuxSession: 'worker-1' }, LONG_MULTILINE_ANNOTATION);

      const loadCall = mockExecSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd === 'tmux load-buffer -',
      );
      expect(loadCall, 'expected load-buffer invocation').toBeDefined();
      const options = loadCall![1] as { input: string };
      expect(options.input).toBe(LONG_MULTILINE_ANNOTATION);
      // Sanity: the bug is only interesting when the message has newlines.
      expect(options.input.split('\n').length).toBeGreaterThan(5);
    });
  });

  describe('pressEnter option', () => {
    it('sends Enter when pressEnter is true (local)', () => {
      const messenger = new TmuxSessionMessenger();

      messenger.send({ tmuxSession: 'worker-1' }, 'felt show foo', { pressEnter: true });

      const enterCall = mockExecSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('send-keys') && cmd.includes('Enter'),
      );
      expect(enterCall).toBeDefined();
    });

    it('does not send Enter when pressEnter is false (default)', () => {
      const messenger = new TmuxSessionMessenger();

      messenger.send({ tmuxSession: 'worker-1' }, LONG_MULTILINE_ANNOTATION);

      const enterCall = mockExecSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('send-keys') && cmd.includes('Enter'),
      );
      expect(enterCall).toBeUndefined();
    });
  });
});
