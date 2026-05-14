import { execFile } from 'child_process';
import type { ServerResponse } from 'http';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import { reconnectTunnel } from './RemoteAgentCoordinator.js';
import type { RemoteAgentConnectionDiagnostic, RemoteAgentRuntime } from './OriginManager.js';
import {
  NODE_AGENT_FALLBACK_PREFLIGHT_COMMAND,
  RUST_AGENT_PREFLIGHT_COMMAND,
  parseRemoteAgentRuntime,
  remoteAgentCommand,
  remoteAgentTmuxSession,
  replacedRemoteAgentTmuxSessions,
  type RemoteAgentStartupOptions,
} from './RemoteAgentRuntime.js';
import type { RemoteAgentRuntimePreferences } from './RemoteAgentRuntimePreferenceStore.js';
import { baseRemoteSshHost } from './RemoteAgentHostIdentity.js';
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
  remoteReachabilityTimeoutMs?: number;
  runtimePreferences?: RemoteAgentRuntimePreferences;
  getConnectedRemoteAgents?: () => RemoteAgentConnectionDiagnostic[];
}

interface ActivationBody {
  cityId?: string;
  agentRuntime?: string;
  origin?: string;
  plannotatorPort?: number | string;
  once?: boolean;
}

function parseActivationBody(body: unknown): ActivationBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  return body as ActivationBody;
}

function parsePlannotatorPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`Invalid plannotatorPort: ${value}`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || `${parsed}` !== value.trim() || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid plannotatorPort: ${value}`);
    }
    return parsed;
  }
  throw new Error(`Invalid plannotatorPort: ${String(value)}`);
}

function parseRustActivationOptions(body: ActivationBody, runtime: RemoteAgentRuntime): RemoteAgentStartupOptions {
  if (runtime !== 'rust') {
    return {};
  }

  const origin = body.origin?.trim();
  const plannotatorPort = parsePlannotatorPort(body.plannotatorPort);
  const once = body.once;

  if (once !== undefined && typeof once !== 'boolean') {
    throw new Error(`Invalid once flag: ${String(once)}`);
  }

  const options: RemoteAgentStartupOptions = {};
  if (origin) options.origin = origin;
  if (plannotatorPort !== undefined) options.plannotatorPort = plannotatorPort;
  if (once === true) options.once = once;
  return options;
}

function isDuplicateTmuxSessionError(error: unknown, session: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`duplicate session: ${session}`);
}

export class HttpApiActivation {
  private readonly cityLookup: CityLookup;
  private readonly getSshHost: (city: City) => string;
  private readonly reconnectTunnelFn: (sshHost: string) => Promise<void>;
  private readonly execFileFn: typeof execFileAsync;
  private readonly remoteReachabilityTimeoutMs: number;
  private readonly runtimePreferences: RemoteAgentRuntimePreferences | undefined;
  private readonly getConnectedRemoteAgents: (() => RemoteAgentConnectionDiagnostic[]) | undefined;

  constructor(options: HttpApiActivationOptions) {
    this.cityLookup = options.cityLookup;
    this.getSshHost = options.getSshHost;
    this.reconnectTunnelFn = options.reconnectTunnelFn ?? reconnectTunnel;
    this.execFileFn = options.execFileFn ?? execFileAsync;
    this.remoteReachabilityTimeoutMs = options.remoteReachabilityTimeoutMs ?? 60_000;
    this.runtimePreferences = options.runtimePreferences;
    this.getConnectedRemoteAgents = options.getConnectedRemoteAgents;
  }

  async handleActivateCity(url: URL, res: ServerResponse, body?: unknown): Promise<void> {
    const payload = parseActivationBody(body);
    const cityId = payload.cityId ?? url.searchParams.get('cityId');
    console.log(`[Activate] Received request for cityId=${cityId}`);
    const requestedRuntime = payload.agentRuntime ?? url.searchParams.get('agentRuntime');
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

    if (city.originId === 'local') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot activate local city - start a session manually' }));
      return;
    }

    const sshHost = this.getSshHost(city);
    const preferredRuntime = this.runtimePreferences?.getPreferredRuntime(sshHost)
      ?? this.runtimePreferences?.getDefaultRuntime()
      ?? 'rust';
    let runtime: RemoteAgentRuntime;
    try {
      runtime = parseRemoteAgentRuntime(requestedRuntime, preferredRuntime);
    } catch (error: unknown) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
      return;
    }

    let rustOptions: RemoteAgentStartupOptions;
    try {
      rustOptions = parseRustActivationOptions(payload, runtime);
    } catch (error: unknown) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
      return;
    }

    const runtimeSession = remoteAgentTmuxSession(runtime);
    const replacedRuntimeSessions = replacedRemoteAgentTmuxSessions(runtime);
    const startCommand = remoteAgentCommand(runtime, sshHost, rustOptions);
    const replacesRuntime = !(runtime === 'rust' && rustOptions.once);
    const connectedAgent = this.findConnectedRemoteAgent(sshHost, runtime);

    if (connectedAgent) {
      if (replacesRuntime) {
        this.recordPreferredRuntime(sshHost, runtime);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        status: 'already_running',
        message: `Agent (${runtime}) already connected on ${sshHost}`,
        ...this.preferenceResponse(sshHost),
      }));
      return;
    }

    try {
      // Avoid churning a healthy reverse tunnel. Candide can impose a short
      // SSH backoff after failed or restarted opens, so only kickstart when
      // the remote cannot already see the local backend.
      const tunnelAlreadyReachable = await isRemotePortolanReachable(sshHost, this.execFileFn);
      if (!tunnelAlreadyReachable) {
        await this.reconnectTunnelFn(sshHost);
        const reachable = await waitForRemotePortolan(
          sshHost,
          this.execFileFn,
          this.remoteReachabilityTimeoutMs,
        );
        if (!reachable) {
          throw new Error(`${sshHost}: tunnel unreachable after kickstart`);
        }
      }

      const { stdout: checkOutput } = await this.execFileFn(
        'ssh',
        ['-T', sshHost, `tmux has-session -t ${exactTmuxTarget(runtimeSession)} 2>/dev/null && echo running || echo stopped`],
        { timeout: 60_000 }
      );

      if (checkOutput.trim() === 'running') {
        if (replacesRuntime) {
          await killRemoteAgentSessions(sshHost, replacedRuntimeSessions, this.execFileFn);
          this.recordPreferredRuntime(sshHost, runtime);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          status: 'already_running',
          message: `Agent (${runtime}) already running on ${sshHost}`,
          ...this.preferenceResponse(sshHost),
        }));
        return;
      }

      if (runtime === 'rust') {
        await assertRustAgentInstalled(sshHost, this.execFileFn);
      }
      if (runtime === 'node') {
        await assertNodeFallbackInstalled(sshHost, this.execFileFn);
      }

      if (replacesRuntime) {
        await killRemoteAgentSessions(sshHost, replacedRuntimeSessions, this.execFileFn);
      }

      console.log(`[Activate] Starting ${runtime} portolan agent on ${sshHost}...`);
      const remoteCommand = `tmux new-session -d -s ${shellEscape(runtimeSession)} ${shellEscape(`bash -l -c ${shellEscape(startCommand)}`)}`;
      try {
        await this.execFileFn(
          'ssh',
          ['-T', sshHost, remoteCommand],
          { timeout: 60_000 }
        );
      } catch (error: any) {
        if (!isDuplicateTmuxSessionError(error, runtimeSession)) {
          throw error;
        }
        if (replacesRuntime) {
          this.recordPreferredRuntime(sshHost, runtime);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          status: 'already_running',
          message: `Agent (${runtime}) already running on ${sshHost}`,
          ...this.preferenceResponse(sshHost),
        }));
        return;
      }
      if (replacesRuntime) {
        this.recordPreferredRuntime(sshHost, runtime);
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        status: 'started',
        message: `${runtime} agent started on ${sshHost} (${runtimeSession})`,
        ...this.preferenceResponse(sshHost),
      }));
    } catch (error: any) {
      console.error(`[Activate] Failed to start agent on ${sshHost}:`, error.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: `Failed to start agent: ${error.message}` }));
    }
  }

  private preferenceResponse(sshHost: string): { preferredRuntime?: RemoteAgentRuntime | null } {
    if (!this.runtimePreferences) return {};
    return {
      preferredRuntime: this.runtimePreferences.getPreferredRuntime(sshHost)
        ?? this.runtimePreferences.getDefaultRuntime(),
    };
  }

  private recordPreferredRuntime(sshHost: string, runtime: RemoteAgentRuntime): void {
    try {
      this.runtimePreferences?.setPreferredRuntime(sshHost, runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Activate] Failed to persist ${sshHost} runtime preference: ${message}`);
    }
  }

  private findConnectedRemoteAgent(
    sshHost: string,
    runtime: RemoteAgentRuntime,
  ): RemoteAgentConnectionDiagnostic | undefined {
    const normalizedSshHost = baseRemoteSshHost(sshHost);
    return this.getConnectedRemoteAgents?.().find((agent) => (
      agent.sshHost !== null
      && baseRemoteSshHost(agent.sshHost) === normalizedSshHost
      && agent.agentRuntime === runtime
      && agent.socketCount > 0
    ));
  }
}

async function killRemoteAgentSessions(
  sshHost: string,
  sessions: string[],
  execFileFn: typeof execFileAsync,
): Promise<void> {
  if (sessions.length === 0) return;
  await execFileFn(
    'ssh',
    ['-T', sshHost, sessions.map((session) => (
      `tmux kill-session -t ${exactTmuxTarget(session)} 2>/dev/null || true`
    )).join('; ')],
    { timeout: 60_000 },
  );
}

async function assertNodeFallbackInstalled(
  sshHost: string,
  execFileFn: typeof execFileAsync,
): Promise<void> {
  try {
    await execFileFn(
      'ssh',
      [
        '-T',
        sshHost,
        NODE_AGENT_FALLBACK_PREFLIGHT_COMMAND,
      ],
      { timeout: 60_000 },
    );
  } catch {
    throw new Error(
      `${sshHost}: Node fallback is not installed; run ./scripts/install-remote.sh --agent-runtime node ${sshHost} before activating agentRuntime=node`,
    );
  }
}

async function assertRustAgentInstalled(
  sshHost: string,
  execFileFn: typeof execFileAsync,
): Promise<void> {
  try {
    await execFileFn(
      'ssh',
      [
        '-T',
        sshHost,
        RUST_AGENT_PREFLIGHT_COMMAND,
      ],
      { timeout: 60_000 },
    );
  } catch {
    throw new Error(
      `${sshHost}: Rust agent is not installed or executable at ~/.local/bin/portolan-agent-rust; run ./scripts/install-remote.sh ${sshHost} before activating agentRuntime=rust`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRemotePortolanReachable(
  sshHost: string,
  execFileFn: typeof execFileAsync,
): Promise<boolean> {
  try {
    await execFileFn(
      'ssh',
      ['-T', sshHost, 'curl -sS --connect-timeout 3 http://localhost:4004/debug-runtime >/dev/null'],
      { timeout: 60_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForRemotePortolan(
  sshHost: string,
  execFileFn: typeof execFileAsync,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRemotePortolanReachable(sshHost, execFileFn)) {
      return true;
    }
    await delay(1_000);
  }
  return false;
}
