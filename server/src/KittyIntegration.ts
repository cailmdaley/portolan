/**
 * KittyIntegration - Terminal focus, new workers, handoff
 *
 * Handles all interaction with Kitty terminal:
 * - Focusing existing tmux sessions (local and remote)
 * - Launching new workers (tmux + claude, local and remote)
 * - Handoff (launch claude with fiber context)
 * - Killing workers
 */

import { execSync } from 'child_process';
import type { WebSocket } from 'ws';
import type { Session } from './SessionTracker.js';
import type { Origin } from './OriginManager.js';
import type { City } from './CityManager.js';
import { cliProvider, getProvider } from './cli-provider.js';
import { KittyHandoff } from './KittyHandoff.js';
import { shellEscape } from './ShellPathUtils.js';

// ============================================================================
// Types
// ============================================================================

interface SessionLookup {
  findSession(sessionId: string): Session | undefined;
}

interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface CityLookup {
  findCityByPath(path: string): City | undefined;
  getSshHost(city: City): string | undefined;
}

export class KittyIntegration {
  private sessionLookup: SessionLookup;
  private originLookup: OriginLookup;
  private cityLookup: CityLookup;
  private handoffController: KittyHandoff;

  constructor(
    sessionLookup: SessionLookup,
    originLookup: OriginLookup,
    cityLookup: CityLookup
  ) {
    this.sessionLookup = sessionLookup;
    this.originLookup = originLookup;
    this.cityLookup = cityLookup;
    this.handoffController = new KittyHandoff({
      cityLookup,
      getSocket: () => this.getSocket(),
      getSshAuthSockEnv: () => this.getSshAuthSockEnv(),
      activateKitty: () => this.activateKitty(),
    });
  }

  /**
   * Get the Kitty socket path
   */
  getSocket(): string {
    return process.env.KITTY_LISTEN_ON || 'unix:/tmp/kitty-socket';
  }

  /**
   * Get Kitty --env flag for SSH_AUTH_SOCK (allows SSH agent in Kitty tabs)
   */
  getSshAuthSockEnv(): string {
    return process.env.SSH_AUTH_SOCK ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` : '';
  }

  /**
   * Bring Kitty to front (macOS)
   */
  activateKitty(): void {
    try {
      execSync(`osascript -e 'tell app "kitty" to activate'`, { stdio: 'ignore' });
    } catch (error) {
      console.error('Failed to activate Kitty:', error);
    }
  }

  /**
   * Focus a tmux session in Kitty
   * For local sessions: focus or create a tab
   * For remote sessions: SSH to the remote and attach to tmux
   */
  focusSession(sessionId: string): void {
    const session = this.sessionLookup.findSession(sessionId);

    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      return;
    }

    const socket = this.getSocket();
    const tmuxSession = session.tmuxSession;
    const escapedSession = shellEscape(tmuxSession);
    // Use regex anchors for exact title match
    const exactTitleMatch = shellEscape(`^${tmuxSession}$`);

    if (session.originId === 'local') {
      // Local session
      const escapedCwd = shellEscape(session.cwd);

      try {
        // Try to focus existing tab (exact match)
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, {
          stdio: 'ignore',
        });
        console.log(`Focused tab: ${tmuxSession}`);
      } catch {
        // No tab exists - create one with correct working directory
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
      // Remote session - SSH + tmux attach
      const origin = this.originLookup.getOrigin(session.originId);
      if (!origin || !origin.sshHost) {
        console.error(`Cannot focus remote session: no sshHost for origin ${session.originId}`);
        return;
      }

      // Agent provides specific node SSH host for multi-node HPC systems
      const sshHost = origin.sshHost;

      const tabTitle = `${tmuxSession}@${origin.name}`;
      const escapedTabTitle = shellEscape(tabTitle);
      const exactRemoteTitleMatch = shellEscape(`^${tabTitle}$`);

      try {
        // Try to focus existing tab (exact match)
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactRemoteTitleMatch}`, {
          stdio: 'ignore',
        });
        console.log(`Focused remote tab: ${tabTitle}`);
      } catch {
        // No tab exists - create one with SSH + tmux attach
        // Use -tt to force TTY allocation even when launched from another program
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

  /**
   * Core worker creation logic - creates tmux session and kitty tab.
   * Returns tmux session name on success, throws on error.
   * Used by newWorker() and HttpApi callback.
   */
  createWorker(
    cityPath: string,
    options: { sshHost?: string; originDisplayName?: string; customName?: string; chrome?: boolean; continue?: boolean; cli?: string } = {}
  ): string {
    const { sshHost, originDisplayName, customName, chrome, continue: continueSession, cli } = options;
    const isRemote = !!sshHost;
    const socket = this.getSocket();
    const escapedCwd = shellEscape(cityPath);

    // Generate session name
    const baseName = customName || cityPath.split('/').pop() || 'worker';
    const timestamp = Date.now().toString(36).slice(-4);
    const tmuxSession = customName ? customName : `${baseName}-${timestamp}`;
    const escapedSession = shellEscape(tmuxSession);

    // Build CLI command with optional flags
    const provider = cli ? getProvider(cli) : cliProvider;
    const cliCmd = provider.launchCmd({ continue: continueSession, chrome });

    if (isRemote) {
      // Remote: create tmux session on remote via SSH
      const remoteTmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'bash -l -c "${cliCmd}"'`;
      const sshCmd = `ssh -T ${sshHost} ${shellEscape(remoteTmuxCmd)}`;
      console.log('[CreateWorker] Creating remote tmux session:', sshCmd);
      execSync(sshCmd, { stdio: 'pipe', timeout: 30000 });

      // Open kitty tab that SSH's to remote and attaches to tmux
      const tabTitle = `${tmuxSession}@${originDisplayName || 'remote'}`;
      const kittyCmd = `kitty @ --to ${socket} launch --type=tab ${this.getSshAuthSockEnv()} --title=${shellEscape(tabTitle)} ssh -tt ${sshHost} tmux attach -t ${escapedSession}`;
      console.log('[CreateWorker] Opening kitty tab with SSH:', kittyCmd);
      execSync(kittyCmd, { stdio: 'pipe' });

      // Focus the newly created tab
      const exactTitleMatch = shellEscape(`^${tabTitle}$`);
      execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

      console.log(`[CreateWorker] Launched remote worker: ${tmuxSession} on ${sshHost}:${cityPath}`);
    } else {
      // Local: create tmux session locally
      const tmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'zsh -l -c "${cliCmd}"'`;
      console.log('[CreateWorker] Creating local tmux session:', tmuxCmd);
      execSync(tmuxCmd, { stdio: 'pipe' });

      // Open kitty tab attached to the tmux session
      const kittyCmd = `kitty @ --to ${socket} launch --type=tab --cwd=${escapedCwd} --title=${escapedSession} tmux attach -t ${escapedSession}`;
      console.log('[CreateWorker] Opening kitty tab:', kittyCmd);
      execSync(kittyCmd, { stdio: 'pipe' });

      // Focus the newly created tab
      const exactTitleMatch = shellEscape(`^${tmuxSession}$`);
      execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

      console.log(`[CreateWorker] Launched local worker: ${tmuxSession} in ${cityPath}`);
    }

    this.activateKitty();
    return tmuxSession;
  }

  /**
   * Handle new worker request - launch Claude Code in city directory via tmux
   * Supports both local and remote cities
   */
  newWorker(ws: WebSocket, cityPath: string, customName?: string, chrome?: boolean, continueSession?: boolean, cli?: string): void {
    console.log('[NewWorker] Starting for path:', cityPath, customName ? `(name: ${customName})` : '', chrome ? '(chrome)' : '', continueSession ? '(-c)' : '', cli ? `(cli: ${cli})` : '');

    // Find the city to determine if it's local or remote
    const city = this.cityLookup.findCityByPath(cityPath);
    const isRemote = city && city.originId !== 'local';

    // Get SSH host for remote cities
    let sshHost: string | undefined;
    let originDisplayName: string | undefined;
    if (isRemote && city) {
      sshHost = this.cityLookup.getSshHost(city);
      originDisplayName = city.originId.replace('remote-', '');
      console.log(`[NewWorker] Remote city detected, using SSH host: ${sshHost}`);
    }

    // Check if custom-named tmux session already exists
    if (customName) {
      try {
        const escapedSession = shellEscape(customName);
        const checkCmd = sshHost
          ? `ssh -T ${sshHost} 'tmux has-session -t ${escapedSession} 2>/dev/null'`
          : `tmux has-session -t ${escapedSession} 2>/dev/null`;
        execSync(checkCmd, { stdio: 'pipe' });
        // If we get here, session exists
        console.log(`[NewWorker] Session "${customName}" already exists`);
        ws.send(JSON.stringify({
          type: 'error',
          message: `Worker "${customName}" already exists. Choose a different name.`,
        }));
        return;
      } catch {
        // Session doesn't exist - good, continue
      }
    }

    try {
      this.createWorker(cityPath, { sshHost, originDisplayName, customName, chrome, continue: continueSession, cli });
    } catch (error: unknown) {
      const err = error as { message?: string; stderr?: Buffer };
      const errMsg = err.stderr?.toString() || err.message || 'Unknown error';
      console.error(`[NewWorker] Failed to launch worker in ${cityPath}:`, errMsg);

      if (errMsg.includes('duplicate session')) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Worker "${customName}" already exists.`,
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Failed to create worker: ${errMsg}`,
        }));
      }
    }
  }

  /**
   * Handle handoff request - launch Claude Code with fiber context
   * Supports both local and remote cities
   *
   * Sequence:
   * 1. Create tmux session with Claude
   * 2. Open kitty tab attached to tmux
   * 3. Wait for Claude to start (2 seconds)
   * 4. Send `felt show <fiberId>` as first message via tmux send-keys
   */
  async handoff(fiberId: string, cityPath: string, cli?: string): Promise<void> {
    await this.handoffController.handoff(fiberId, cityPath, cli);
  }

  /**
   * Handle killWorker request - kill tmux session
   * Supports both local and remote sessions
   */
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
        // Remote session - kill via SSH
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
