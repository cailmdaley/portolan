import { execFile } from 'child_process';
import type { ServerResponse } from 'http';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import { reconnectTunnel } from './RemoteAgentCoordinator.js';
import { exactTmuxTarget, shellEscape } from './ShellPathUtils.js';

const execFileAsync = promisify(execFile);

interface CityLookup {
  getCityById(cityId: string): City | null;
}

interface HttpApiActivationOptions {
  cityLookup: CityLookup;
  getSshHost: (city: City) => string;
  reconnectTunnelFn?: (sshHost: string) => Promise<void>;
  execFileFn?: typeof execFileAsync;
}

type RemoteAgentRuntime = 'node' | 'rust';

const NODE_AGENT_SESSION = 'portolan-agent';
const RUST_AGENT_SESSION = 'portolan-agent-rust-preview';

function parseAgentRuntime(value: string | null): RemoteAgentRuntime {
  if (!value || value === 'node') {
    return 'node';
  }
  if (value === 'rust') {
    return 'rust';
  }
  throw new Error(`Invalid agent runtime: ${value}`);
}

function agentSessionForRuntime(runtime: RemoteAgentRuntime): string {
  return runtime === 'rust' ? RUST_AGENT_SESSION : NODE_AGENT_SESSION;
}

function agentStartCommand(runtime: RemoteAgentRuntime, sshHost: string): string {
  if (runtime === 'rust') {
    return `~/.local/bin/portolan-agent-rust connect --ssh-host=${shellEscape(sshHost)}`;
  }
  return `node ~/.local/bin/portolan-agent.js connect --ssh-host=${shellEscape(sshHost)}`;
}

export class HttpApiActivation {
  private readonly cityLookup: CityLookup;
  private readonly getSshHost: (city: City) => string;
  private readonly reconnectTunnelFn: (sshHost: string) => Promise<void>;
  private readonly execFileFn: typeof execFileAsync;

  constructor(options: HttpApiActivationOptions) {
    this.cityLookup = options.cityLookup;
    this.getSshHost = options.getSshHost;
    this.reconnectTunnelFn = options.reconnectTunnelFn ?? reconnectTunnel;
    this.execFileFn = options.execFileFn ?? execFileAsync;
  }

  async handleActivateCity(url: URL, res: ServerResponse): Promise<void> {
    console.log(`[Activate] Received request for cityId=${url.searchParams.get('cityId')}`);
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing cityId parameter' }));
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'City not found' }));
      return;
    }

    let runtime: RemoteAgentRuntime;
    try {
      runtime = parseAgentRuntime(url.searchParams.get('agentRuntime'));
    } catch (error: unknown) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
      return;
    }

    if (city.originId === 'local') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot activate local city - start a session manually' }));
      return;
    }

    const sshHost = this.getSshHost(city);
    const runtimeSession = agentSessionForRuntime(runtime);
    const startCommand = agentStartCommand(runtime, sshHost);

    try {
      // Reset tunnel first — kills stale ControlMaster and re-establishes
      // RemoteForward so the agent can reach localhost:4004.
      await this.reconnectTunnelFn(sshHost);

      const { stdout: checkOutput } = await this.execFileFn(
        'ssh',
        ['-T', sshHost, `tmux has-session -t ${exactTmuxTarget(runtimeSession)} 2>/dev/null && echo running || echo stopped`],
        { timeout: 10000 }
      );

      if (checkOutput.trim() === 'running') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'already_running', message: `Agent (${runtime}) already running on ${sshHost}` }));
        return;
      }

      console.log(`[Activate] Starting ${runtime} portolan agent on ${sshHost}...`);
      const remoteCommand = `tmux new-session -d -s ${shellEscape(runtimeSession)} ${shellEscape(`bash -l -c ${shellEscape(startCommand)}`)}`;
      await this.execFileFn(
        'ssh',
        ['-T', sshHost, remoteCommand],
        { timeout: 30000 }
      );

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: 'started', message: `${runtime} agent started on ${sshHost} (${runtimeSession})` }));
    } catch (error: any) {
      console.error(`[Activate] Failed to start agent on ${sshHost}:`, error.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: `Failed to start agent: ${error.message}` }));
    }
  }
}
