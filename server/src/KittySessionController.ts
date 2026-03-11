import { execSync } from 'child_process';
import type { Session } from './SessionTracker.js';
import type { Origin } from './OriginManager.js';
import { shellEscape } from './ShellPathUtils.js';

export interface KittySessionLookup {
  findSession(sessionId: string): Session | undefined;
}

export interface KittyOriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface KittySessionControllerOptions {
  sessionLookup: KittySessionLookup;
  originLookup: KittyOriginLookup;
  getSocket: () => string;
  getSshAuthSockEnv: () => string;
  activateKitty: () => void;
}

export class KittySessionController {
  private sessionLookup: KittySessionLookup;
  private originLookup: KittyOriginLookup;
  private getSocket: () => string;
  private getSshAuthSockEnv: () => string;
  private activateKitty: () => void;

  constructor(options: KittySessionControllerOptions) {
    this.sessionLookup = options.sessionLookup;
    this.originLookup = options.originLookup;
    this.getSocket = options.getSocket;
    this.getSshAuthSockEnv = options.getSshAuthSockEnv;
    this.activateKitty = options.activateKitty;
  }

  focusSession(sessionId: string): void {
    const session = this.sessionLookup.findSession(sessionId);

    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      return;
    }

    const socket = this.getSocket();
    const tmuxSession = session.tmuxSession;
    const escapedSession = shellEscape(tmuxSession);
    const exactTitleMatch = shellEscape(`^${tmuxSession}$`);

    if (session.originId === 'local') {
      const escapedCwd = shellEscape(session.cwd);

      try {
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, {
          stdio: 'ignore',
        });
        console.log(`Focused tab: ${tmuxSession}`);
      } catch {
        try {
          execSync(
            `kitty @ --to ${socket} launch --type=tab --cwd=${escapedCwd} --title=${escapedSession} tmux attach -t ${escapedSession}`,
            { stdio: 'ignore' }
          );
          console.log(`Launched new tab: ${tmuxSession} in ${session.cwd}`);
        } catch (error) {
          console.error(`Failed to launch tab for ${tmuxSession}:`, error);
        }
      }
    } else {
      const origin = this.originLookup.getOrigin(session.originId);
      if (!origin || !origin.sshHost) {
        console.error(`Cannot focus remote session: no sshHost for origin ${session.originId}`);
        return;
      }

      const sshHost = origin.sshHost;
      const tabTitle = `${tmuxSession}@${origin.name}`;
      const escapedTabTitle = shellEscape(tabTitle);
      const exactRemoteTitleMatch = shellEscape(`^${tabTitle}$`);

      try {
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactRemoteTitleMatch}`, {
          stdio: 'ignore',
        });
        console.log(`Focused remote tab: ${tabTitle}`);
      } catch {
        try {
          const sshCommand = `ssh -tt ${shellEscape(sshHost)} tmux attach -t ${escapedSession}`;
          const kittyCmd = `kitty @ --to ${socket} launch --type=tab ${this.getSshAuthSockEnv()} --title=${escapedTabTitle} ${sshCommand}`;
          console.log(`[Focus] Running: ${kittyCmd}`);
          execSync(kittyCmd, { stdio: 'ignore' });
          console.log(`Launched remote tab: ${tabTitle} via ${sshHost}`);
        } catch (error) {
          console.error(`Failed to launch remote tab for ${tmuxSession}:`, error);
        }
      }
    }

    this.activateKitty();
  }

  killWorker(sessionId: string): void {
    const session = this.sessionLookup.findSession(sessionId);

    if (!session) {
      console.error(`[KillWorker] Session not found: ${sessionId}`);
      return;
    }

    const escapedSession = shellEscape(session.tmuxSession);

    try {
      if (session.originId === 'local') {
        execSync(`tmux kill-session -t ${escapedSession}`, { stdio: 'pipe' });
        console.log(`[KillWorker] Killed local session: ${session.tmuxSession}`);
      } else {
        const origin = this.originLookup.getOrigin(session.originId);
        if (!origin || !origin.sshHost) {
          console.error(`[KillWorker] Cannot kill remote session: no sshHost for origin ${session.originId}`);
          return;
        }

        const remoteTmuxCmd = `tmux kill-session -t ${escapedSession}`;
        const sshCmd = `ssh ${origin.sshHost} ${shellEscape(remoteTmuxCmd)}`;
        execSync(sshCmd, { stdio: 'pipe', timeout: 10000 });
        console.log(`[KillWorker] Killed remote session: ${session.tmuxSession} on ${origin.sshHost}`);
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.error(`[KillWorker] Failed to kill session ${session.tmuxSession}:`, err.message);
    }
  }
}
