import { describe, expect, it } from 'vitest';

import {
  remoteAgentCommand,
  remoteAgentRuntimeProfiles,
  remoteAgentTmuxSession,
} from '../RemoteAgentRuntime.js';

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
});
