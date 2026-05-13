import type { RemoteAgentRuntime } from './OriginManager.js';
import { shellEscape } from './ShellPathUtils.js';

export const NODE_AGENT_TMUX_SESSION = 'portolan-agent';
export const RUST_AGENT_TMUX_SESSION = 'portolan-agent-rust';
export const LEGACY_RUST_AGENT_TMUX_SESSION = 'portolan-agent-rust-preview';

export interface RemoteAgentStartupOptions {
  origin?: string;
  plannotatorPort?: number;
  once?: boolean;
}

export interface RemoteAgentRuntimeProfile {
  runtime: RemoteAgentRuntime;
  tmuxSession: string;
  replacesTmuxSessions: string[];
  commandTemplate: string;
  supportsOnce: boolean;
}

const TEMPLATE_SSH_HOST = '<ssh-host>';

export function remoteAgentTmuxSession(agentRuntime: RemoteAgentRuntime): string {
  return agentRuntime === 'rust' ? RUST_AGENT_TMUX_SESSION : NODE_AGENT_TMUX_SESSION;
}

export function replacedRemoteAgentTmuxSessions(agentRuntime: RemoteAgentRuntime): string[] {
  if (agentRuntime === 'rust') {
    return [NODE_AGENT_TMUX_SESSION, LEGACY_RUST_AGENT_TMUX_SESSION];
  }
  return [RUST_AGENT_TMUX_SESSION, LEGACY_RUST_AGENT_TMUX_SESSION];
}

export function remoteAgentCommand(
  agentRuntime: RemoteAgentRuntime,
  sshHost: string,
  startupOptions: RemoteAgentStartupOptions = {},
): string {
  if (agentRuntime === 'rust') {
    return rustRemoteAgentCommand(sshHost, startupOptions);
  }

  return `node ~/.local/bin/portolan-agent.js connect --ssh-host=${shellEscape(sshHost)}`;
}

export function remoteAgentRuntimeProfiles(): RemoteAgentRuntimeProfile[] {
  return (['rust', 'node'] satisfies RemoteAgentRuntime[]).map((runtime) => ({
    runtime,
    tmuxSession: remoteAgentTmuxSession(runtime),
    replacesTmuxSessions: replacedRemoteAgentTmuxSessions(runtime),
    commandTemplate: remoteAgentCommand(runtime, TEMPLATE_SSH_HOST),
    supportsOnce: runtime === 'rust',
  }));
}

function rustRemoteAgentCommand(
  sshHost: string,
  options: RemoteAgentStartupOptions = {},
): string {
  const origin = options.origin ? ` --origin=${shellEscape(options.origin)}` : '';
  const plannotatorPort = options.plannotatorPort !== undefined
    ? ` --plannotator-port=${shellEscape(String(options.plannotatorPort))}`
    : '';
  const once = options.once ? ' --once' : '';
  return `~/.local/bin/portolan-agent-rust connect --ssh-host=${shellEscape(sshHost)}${origin}${plannotatorPort}${once}`;
}
