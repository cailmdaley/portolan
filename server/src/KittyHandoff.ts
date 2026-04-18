import { execSync } from 'child_process';
import type { City } from './CityManager.js';
import { cliProvider, getProvider } from './cli-provider.js';
import { exactTmuxTarget, shellEscape } from './ShellPathUtils.js';
import { TmuxSessionMessenger } from './TmuxSessionMessenger.js';

interface CityLookup {
  findCityByPath(path: string): City | undefined;
  getSshHost(city: City): string | undefined;
}

interface KittyHandoffOptions {
  cityLookup: CityLookup;
  getSocket: () => string;
  getSshAuthSockEnv: () => string;
  activateKitty: () => void;
}

export class KittyHandoff {
  private cityLookup: CityLookup;
  private getSocket: () => string;
  private getSshAuthSockEnv: () => string;
  private activateKitty: () => void;
  private tmuxMessenger = new TmuxSessionMessenger();

  constructor(options: KittyHandoffOptions) {
    this.cityLookup = options.cityLookup;
    this.getSocket = options.getSocket;
    this.getSshAuthSockEnv = options.getSshAuthSockEnv;
    this.activateKitty = options.activateKitty;
  }

  async handoff(fiberId: string, cityPath: string, cli?: string): Promise<void> {
    console.log('[Handoff] Starting for fiber:', fiberId, 'path:', cityPath);

    const city = this.cityLookup.findCityByPath(cityPath);
    const isRemote = city && city.originId !== 'local';
    let sshHost: string | undefined;
    if (isRemote && city) {
      sshHost = this.cityLookup.getSshHost(city);
      console.log(`[Handoff] Remote city detected, using SSH host: ${sshHost}`);
    }

    const socket = this.getSocket();
    const escapedCwd = shellEscape(cityPath);
    const tmuxSession = fiberId;
    const escapedSession = shellEscape(tmuxSession);
    const exactSessionTarget = exactTmuxTarget(tmuxSession);

    try {
      const provider = cli ? getProvider(cli) : cliProvider;
      const handoffCmd = provider.launchCmd();
      if (isRemote && sshHost) {
        const remoteTmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} '${provider.remoteShell} -l -c "felt on ${fiberId} && ${handoffCmd} || exec ${provider.remoteShell}"'`;
        const sshCmd = `ssh -T ${sshHost} ${shellEscape(remoteTmuxCmd)}`;
        console.log('[Handoff] Creating remote tmux session:', sshCmd);
        execSync(sshCmd, { stdio: 'pipe', timeout: 30000 });

        const kittyTabTitle = `${tmuxSession}@${city?.originId.replace('remote-', '') || 'remote'}`;
        const kittyCmd = `kitty @ --to ${socket} launch --type=tab ${this.getSshAuthSockEnv()} --title=${shellEscape(kittyTabTitle)} ssh -tt ${sshHost} tmux attach -t ${exactSessionTarget}`;
        console.log('[Handoff] Opening kitty tab with SSH:', kittyCmd);
        execSync(kittyCmd, { stdio: 'pipe' });

        const exactTitleMatch = shellEscape(`^${kittyTabTitle}$`);
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

        console.log(`[Handoff] Launched remote handoff: ${tmuxSession} on ${sshHost}:${cityPath}`);
        await this.sendFiberContextAfterDelay(fiberId, tmuxSession, sshHost, cityPath);
      } else {
        const tmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} '${provider.localShell} -l -c "felt on ${fiberId} && ${handoffCmd} || exec ${provider.localShell}"'`;
        console.log('[Handoff] Creating local tmux session:', tmuxCmd);
        execSync(tmuxCmd, { stdio: 'pipe' });

        const kittyCmd = `kitty @ --to ${socket} launch --type=tab --cwd=${escapedCwd} --title=${escapedSession} tmux attach -t ${exactSessionTarget}`;
        console.log('[Handoff] Opening kitty tab:', kittyCmd);
        execSync(kittyCmd, { stdio: 'pipe' });

        const exactTitleMatch = shellEscape(`^${tmuxSession}$`);
        execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

        console.log(`[Handoff] Launched local handoff: ${tmuxSession} in ${cityPath}`);
        await this.sendFiberContextAfterDelay(fiberId, tmuxSession, undefined, cityPath);
      }
    } catch (error) {
      console.error(`[Handoff] Failed to launch handoff tab for ${fiberId}:`, error);
    }

    this.activateKitty();
  }

  private async sendFiberContextAfterDelay(
    fiberId: string,
    tmuxSession: string,
    sshHost: string | undefined,
    cityPath: string,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 4000));

    let fiberContent: string;
    try {
      if (sshHost) {
        fiberContent = execSync(`ssh ${sshHost} "cd ${shellEscape(cityPath)} && felt show ${fiberId}"`, {
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
      } else {
        fiberContent = execSync(`cd ${shellEscape(cityPath)} && felt show ${fiberId}`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      }
    } catch (error) {
      console.error('[Handoff] Failed to get fiber content:', error);
      fiberContent = `(Could not fetch fiber content. Run \`felt show ${fiberId}\` to see it.)`;
    }

    const message = `This session was opened to work on this fiber:\n\n\`\`\`\n${fiberContent}\n\`\`\``;

    try {
      this.tmuxMessenger.send({ tmuxSession, sshHost }, message, { pressEnter: true });
      console.log(`[Handoff] Sent fiber context for ${fiberId}`);
    } catch (error) {
      console.error('[Handoff] Failed to send fiber context:', error);
    }
  }
}
