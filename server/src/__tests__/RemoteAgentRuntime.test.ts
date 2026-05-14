import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import {
  parseRemoteAgentRuntime,
  remoteAgentCommand,
  remoteAgentRuntimeProfiles,
  remoteAgentTmuxSession,
} from '../RemoteAgentRuntime.js';

function shellRuntimeProfiles(): Record<string, { tmuxSession: string; replacesTmuxSessions: string[] }> {
  const helperPath = fileURLToPath(new URL('../../../scripts/remote-agent-runtime.sh', import.meta.url));
  const stdout = execFileSync(
    'bash',
    [
      '-lc',
      [
        'source "$HELPER_PATH"',
        'printf "rust_tmux=%s\\n" "$(remote_agent_tmux_session rust)"',
        'printf "rust_replaces=%s\\n" "$(replaced_remote_agent_tmux_sessions rust | tr "\\n" " " | sed "s/[[:space:]]*$//")"',
        'printf "node_tmux=%s\\n" "$(remote_agent_tmux_session node)"',
        'printf "node_replaces=%s\\n" "$(replaced_remote_agent_tmux_sessions node | tr "\\n" " " | sed "s/[[:space:]]*$//")"',
      ].join('; '),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HELPER_PATH: helperPath },
    },
  );
  const entries = Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [key, rest.join('=')];
      }),
  );
  return {
    rust: {
      tmuxSession: entries.rust_tmux,
      replacesTmuxSessions: entries.rust_replaces.split(' ').filter(Boolean),
    },
    node: {
      tmuxSession: entries.node_tmux,
      replacesTmuxSessions: entries.node_replaces.split(' ').filter(Boolean),
    },
  };
}

describe('RemoteAgentRuntime', () => {
  it('keeps runtime profile diagnostics aligned with launch helpers', () => {
    expect(remoteAgentRuntimeProfiles()).toEqual([
      {
        runtime: 'rust',
        tmuxSession: 'portolan-agent-rust',
        replacesTmuxSessions: ['portolan-agent', 'portolan-agent-rust-preview'],
        commandTemplate: remoteAgentCommand('rust', '<ssh-host>'),
        supportsOnce: true,
      },
      {
        runtime: 'node',
        tmuxSession: 'portolan-agent',
        replacesTmuxSessions: ['portolan-agent-rust', 'portolan-agent-rust-preview'],
        commandTemplate: remoteAgentCommand('node', '<ssh-host>'),
        supportsOnce: false,
      },
    ]);
  });

  it('uses one session-name source for profile and activation paths', () => {
    for (const profile of remoteAgentRuntimeProfiles()) {
      expect(profile.tmuxSession).toBe(remoteAgentTmuxSession(profile.runtime));
    }
  });

  it('keeps shell runtime helpers aligned with server runtime profiles', () => {
    expect(shellRuntimeProfiles()).toEqual(
      Object.fromEntries(
        remoteAgentRuntimeProfiles().map((profile) => [
          profile.runtime,
          {
            tmuxSession: profile.tmuxSession,
            replacesTmuxSessions: profile.replacesTmuxSessions,
          },
        ]),
      ),
    );
  });

  it('parses runtime identifiers with an explicit fallback', () => {
    expect(parseRemoteAgentRuntime(null, 'node')).toBe('node');
    expect(parseRemoteAgentRuntime(undefined, 'rust')).toBe('rust');
    expect(parseRemoteAgentRuntime('node', 'rust')).toBe('node');
    expect(parseRemoteAgentRuntime('rust', 'node')).toBe('rust');
    expect(() => parseRemoteAgentRuntime('python', 'rust')).toThrow('Invalid agent runtime: python');
  });
});
