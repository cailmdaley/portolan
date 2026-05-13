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
        runtime: 'node',
        tmuxSession: 'portolan-agent',
        replacesTmuxSession: 'portolan-agent-rust-preview',
        commandTemplate: remoteAgentCommand('node', '<ssh-host>'),
        supportsOnce: false,
      },
      {
        runtime: 'rust',
        tmuxSession: 'portolan-agent-rust-preview',
        replacesTmuxSession: 'portolan-agent',
        commandTemplate: remoteAgentCommand('rust', '<ssh-host>'),
        supportsOnce: true,
      },
    ]);
  });

  it('uses one session-name source for profile and activation paths', () => {
    for (const profile of remoteAgentRuntimeProfiles()) {
      expect(profile.tmuxSession).toBe(remoteAgentTmuxSession(profile.runtime));
    }
  });
});
