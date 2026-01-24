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
import { homedir } from 'os';
import type { WebSocket } from 'ws';
import type { Session } from './SessionTracker.js';
import type { Origin } from './OriginManager.js';
import type { City } from './CityManager.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionLookup {
  findSession(sessionId: string): Session | undefined;
  findLocalSession(sessionId: string): Session | undefined;
}

export interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

export interface CityLookup {
  findCityByPath(path: string): City | undefined;
  getSshHost(city: City): string | undefined;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Escape shell arguments for safe use in commands
 * Wraps argument in single quotes and escapes any single quotes within
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Expand ~ to home directory in paths
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return filepath.replace('~', homedir());
  }
  return filepath;
}

// ============================================================================
// KittyIntegration
// ============================================================================

export class KittyIntegration {
  private sessionLookup: SessionLookup;
  private originLookup: OriginLookup;
  private cityLookup: CityLookup;

  constructor(
    sessionLookup: SessionLookup,
    originLookup: OriginLookup,
    cityLookup: CityLookup
  ) {
    this.sessionLookup = sessionLookup;
    this.originLookup = originLookup;
    this.cityLookup = cityLookup;
  }

  /**
   * Get the Kitty socket path
   */
  getSocket(): string {
    return process.env.KITTY_LISTEN_ON || 'unix:/tmp/kitty-socket';
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
          // Pass SSH_AUTH_SOCK so SSH agent works in Kitty tabs
          const sshAuthSock = process.env.SSH_AUTH_SOCK ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` : '';
          const kittyCmd = `kitty @ --to ${socket} launch --type=tab ${sshAuthSock} --title=${escapedTabTitle} ${sshCommand}`;
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
   * Handle new worker request - launch Claude Code in city directory via tmux
   * Supports both local and remote cities
   */
  newWorker(ws: WebSocket, cityPath: string, customName?: string): void {
    console.log('[NewWorker] Starting for path:', cityPath, customName ? `(name: ${customName})` : '');

    // Find the city to determine if it's local or remote
    const city = this.cityLookup.findCityByPath(cityPath);
    const isRemote = city && city.originId !== 'local';

    // Get SSH host for remote cities (agent provides specific node for HPC systems)
    let sshHost: string | undefined;
    if (isRemote && city) {
      sshHost = this.cityLookup.getSshHost(city);
      console.log(`[NewWorker] Remote city detected, using SSH host: ${sshHost}`);
    }

    const socket = this.getSocket();
    const escapedCwd = shellEscape(cityPath);

    // Use custom name or generate from path + timestamp
    const baseName = customName || cityPath.split('/').pop() || 'worker';
    const timestamp = Date.now().toString(36).slice(-4);
    const tmuxSession = customName ? customName : `${baseName}-${timestamp}`;
    const escapedSession = shellEscape(tmuxSession);

    // Check if tmux session already exists
    if (customName) {
      try {
        const checkCmd = isRemote && sshHost
          ? `ssh -T ${sshHost} 'tmux has-session -t ${escapedSession} 2>/dev/null'`
          : `tmux has-session -t ${escapedSession} 2>/dev/null`;
        execSync(checkCmd, { stdio: 'pipe' });
        // If we get here, session exists
        console.log(`[NewWorker] Session "${tmuxSession}" already exists`);
        ws.send(JSON.stringify({
          type: 'error',
          message: `Worker "${tmuxSession}" already exists. Choose a different name.`,
        }));
        return;
      } catch {
        // Session doesn't exist - good, continue
      }
    }

    try {
      if (isRemote && sshHost) {
        // Remote: create tmux session on remote via SSH
        // Use -T to disable TTY for non-interactive command
        const remoteTmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'bash -l -c "claude --dangerously-skip-permissions"'`;
        const sshCmd = `ssh -T ${sshHost} ${shellEscape(remoteTmuxCmd)}`;
        console.log('[NewWorker] Creating remote tmux session:', sshCmd);
        execSync(sshCmd, { stdio: 'pipe', timeout: 30000 });

        // Open kitty tab that SSH's to remote and attaches to tmux
        // Use -tt to force TTY allocation for tmux attach
        // Pass SSH_AUTH_SOCK so SSH agent works in Kitty tabs
        const tabTitle = `${tmuxSession}@${city?.originId.replace('remote-', '') || 'remote'}`;
        const sshAuthSock = process.env.SSH_AUTH_SOCK ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` : '';
        const kittyCmd = `kitty @ --to ${socket} launch --type=tab ${sshAuthSock} --title=${shellEscape(tabTitle)} ssh -tt ${sshHost} tmux attach -t ${escapedSession}`;
        console.log('[NewWorker] Opening kitty tab with SSH:', kittyCmd);
        execSync(kittyCmd, { stdio: 'pipe' });

        // Focus the newly created tab
        const exactTitleMatch = shellEscape(`^${tabTitle}$`);
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

        console.log(`[NewWorker] Launched remote worker: ${tmuxSession} on ${sshHost}:${cityPath}`);
      } else {
        // Local: create tmux session locally
        const tmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'zsh -l -c "claude --dangerously-skip-permissions"'`;
        console.log('[NewWorker] Creating local tmux session:', tmuxCmd);
        execSync(tmuxCmd, { stdio: 'pipe' });

        // Open kitty tab attached to the tmux session
        const kittyCmd = `kitty @ --to ${socket} launch --type=tab --cwd=${escapedCwd} --title=${escapedSession} tmux attach -t ${escapedSession}`;
        console.log('[NewWorker] Opening kitty tab:', kittyCmd);
        execSync(kittyCmd, { stdio: 'pipe' });

        // Focus the newly created tab
        const exactTitleMatch = shellEscape(`^${tmuxSession}$`);
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

        console.log(`[NewWorker] Launched local worker: ${tmuxSession} in ${cityPath}`);
      }
    } catch (error: unknown) {
      const err = error as { message?: string; stderr?: Buffer };
      const errMsg = err.stderr?.toString() || err.message || 'Unknown error';
      console.error(`[NewWorker] Failed to launch worker in ${cityPath}:`, errMsg);

      if (errMsg.includes('duplicate session')) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Worker "${tmuxSession}" already exists.`,
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Failed to create worker: ${errMsg}`,
        }));
      }
      return;
    }

    this.activateKitty();
  }

  /**
   * Handle handoff request - launch Claude Code with fiber context
   * Supports both local and remote cities
   */
  handoff(fiberId: string, cityPath: string): void {
    console.log('[Handoff] Starting for fiber:', fiberId, 'path:', cityPath);

    // Find the city to determine if it's local or remote
    const city = this.cityLookup.findCityByPath(cityPath);
    const isRemote = city && city.originId !== 'local';

    // Get SSH host for remote cities
    let sshHost: string | undefined;
    if (isRemote && city) {
      sshHost = this.cityLookup.getSshHost(city);
      console.log(`[Handoff] Remote city detected, using SSH host: ${sshHost}`);
    }

    const socket = this.getSocket();
    const escapedCwd = shellEscape(cityPath);
    // Use fiber ID as tmux session name (unique per fiber)
    const tmuxSession = fiberId;
    const escapedSession = shellEscape(tmuxSession);

    try {
      if (isRemote && sshHost) {
        // Remote: create tmux session on remote via SSH
        // Use double quotes for inner command (fiberId is alphanumeric+dash, safe for double quotes)
        // || exec bash keeps shell open on failure for debugging
        const remoteTmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'bash -l -c "felt on ${fiberId} && claude --dangerously-skip-permissions || exec bash"'`;
        const sshCmd = `ssh -T ${sshHost} ${shellEscape(remoteTmuxCmd)}`;
        console.log('[Handoff] Creating remote tmux session:', sshCmd);
        execSync(sshCmd, { stdio: 'pipe', timeout: 30000 });

        // Open kitty tab that SSH's to remote and attaches to tmux
        const kittyTabTitle = `${tmuxSession}@${city?.originId.replace('remote-', '') || 'remote'}`;
        const sshAuthSock = process.env.SSH_AUTH_SOCK ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` : '';
        const kittyCmd = `kitty @ --to ${socket} launch --type=tab ${sshAuthSock} --title=${shellEscape(kittyTabTitle)} ssh -tt ${sshHost} tmux attach -t ${escapedSession}`;
        console.log('[Handoff] Opening kitty tab with SSH:', kittyCmd);
        execSync(kittyCmd, { stdio: 'pipe' });

        // Focus the newly created tab
        const exactTitleMatch = shellEscape(`^${kittyTabTitle}$`);
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

        console.log(`[Handoff] Launched remote handoff: ${tmuxSession} on ${sshHost}:${cityPath}`);
      } else {
        // Local: create tmux session (consistent with remote, keeps title stable)
        const tmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'zsh -l -c "felt on ${fiberId} && claude --dangerously-skip-permissions || exec zsh"'`;
        console.log('[Handoff] Creating local tmux session:', tmuxCmd);
        execSync(tmuxCmd, { stdio: 'pipe' });

        // Open kitty tab attached to the tmux session
        const kittyCmd = `kitty @ --to ${socket} launch --type=tab --cwd=${escapedCwd} --title=${escapedSession} tmux attach -t ${escapedSession}`;
        console.log('[Handoff] Opening kitty tab:', kittyCmd);
        execSync(kittyCmd, { stdio: 'pipe' });

        // Focus the newly created tab
        const exactTitleMatch = shellEscape(`^${tmuxSession}$`);
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

        console.log(`[Handoff] Launched local handoff: ${tmuxSession} in ${cityPath}`);
      }
    } catch (error) {
      console.error(`[Handoff] Failed to launch handoff tab for ${fiberId}:`, error);
    }

    this.activateKitty();
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

        const sshCmd = `ssh ${origin.sshHost} tmux kill-session -t ${escapedSession}`;
        execSync(sshCmd, { stdio: 'pipe', timeout: 10000 });
        console.log(`[KillWorker] Killed remote session: ${session.tmuxSession} on ${origin.sshHost}`);
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.error(`[KillWorker] Failed to kill session ${session.tmuxSession}:`, err.message);
    }
  }
}
