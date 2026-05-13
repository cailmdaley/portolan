import { execFileSync, execSync } from 'child_process';
import { exactTmuxTarget, shellEscape } from './ShellPathUtils.js';

export interface TmuxSessionTarget {
  tmuxSession: string;
  sshHost?: string;
}

export interface TmuxSessionMessageOptions {
  pressEnter?: boolean;
  localTimeoutMs?: number;
  remoteTimeoutMs?: number;
}

/**
 * Deliver message text into an existing tmux session.
 * Local sessions use exact tmux targets; remote sessions use bare names
 * for compatibility with older tmux versions.
 *
 * `paste-buffer -p` enables bracketed paste so the receiving TTY (e.g. a
 * Claude Code worker) treats the whole message as a single paste event.
 * Without `-p`, embedded newlines in a multi-paragraph message reach the
 * input handler as raw Enter keypresses, each one triggering submit — so a
 * long annotation gets fragmented into many tiny submissions and the user
 * sees only the trailing chunk in the worker's prompt. Bracketed paste has
 * been in tmux since 2.6 (2017), so every host we target supports it.
 */
export class TmuxSessionMessenger {
  send(
    target: TmuxSessionTarget,
    message: string,
    options: TmuxSessionMessageOptions = {},
  ): void {
    const {
      pressEnter = false,
      localTimeoutMs = 5_000,
      remoteTimeoutMs = 10_000,
    } = options;

    if (target.sshHost) {
      const remoteTarget = shellEscape(target.tmuxSession);
      execFileSync('ssh', [target.sshHost, 'tmux load-buffer -'], {
        input: message,
        timeout: remoteTimeoutMs,
      });
      execFileSync('ssh', [target.sshHost, `tmux paste-buffer -p -t ${remoteTarget}`], {
        timeout: remoteTimeoutMs,
      });
      if (pressEnter) {
        execFileSync('ssh', [target.sshHost, `tmux send-keys -t ${remoteTarget} Enter`], {
          timeout: remoteTimeoutMs,
        });
      }
      return;
    }

    const exactSessionTarget = exactTmuxTarget(target.tmuxSession);
    execSync('tmux load-buffer -', { input: message, timeout: localTimeoutMs });
    execSync(`tmux paste-buffer -p -t ${exactSessionTarget}`, { timeout: localTimeoutMs });
    if (pressEnter) {
      execSync(`tmux send-keys -t ${exactSessionTarget} Enter`, { timeout: localTimeoutMs });
    }
  }
}
