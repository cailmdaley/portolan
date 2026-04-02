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
      execFileSync('ssh', [target.sshHost, `tmux paste-buffer -t ${remoteTarget}`], {
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
    execSync(`tmux paste-buffer -t ${exactSessionTarget}`, { timeout: localTimeoutMs });
    if (pressEnter) {
      execSync(`tmux send-keys -t ${exactSessionTarget} Enter`, { timeout: localTimeoutMs });
    }
  }
}
