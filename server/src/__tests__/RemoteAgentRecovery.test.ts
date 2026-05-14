import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { recoverRemoteAgent } from '../RemoteAgentCoordinator.js';
import { shellEscape } from '../ShellPathUtils.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const NODE_AGENT_SESSION = 'portolan-agent';
const RUST_AGENT_SESSION = 'portolan-agent-rust';
const LEGACY_RUST_AGENT_SESSION = 'portolan-agent-rust-preview';

function resolveExec(stdout = '') {
  return (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, stdout, '');
    return {} as any;
  };
}

describe('recoverRemoteAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not kickstart launchd when the remote backend is already reachable', async () => {
    mockExecFile.mockImplementation(resolveExec());

    const result = await recoverRemoteAgent('candide', 'rust', { origin: 'candide' });

    expect(result).toEqual({
      sshHost: 'candide',
      tunnel: 'reachable',
      agent: 'restarted',
      message: 'candide: tunnel already reachable; restarted portolan-agent-rust',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile.mock.calls[0]?.[0]).toBe('ssh');
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual([
      '-T',
      'candide',
      'curl -sS --connect-timeout 3 http://localhost:4004/debug-runtime >/dev/null',
    ]);
    expect(mockExecFile.mock.calls.some((call) => call[0] === 'launchctl')).toBe(false);

    const expectedAgentCommand = `~/.local/bin/portolan-agent-rust connect --ssh-host=${shellEscape('candide')} --origin=${shellEscape('candide')}`;
    expect(mockExecFile.mock.calls[1]?.[1]).toEqual([
      '-T',
      'candide',
      [
        `tmux kill-session -t ${shellEscape(`=${RUST_AGENT_SESSION}:`)} 2>/dev/null || true`,
        `tmux kill-session -t ${shellEscape(`=${NODE_AGENT_SESSION}:`)} 2>/dev/null || true`,
        `tmux kill-session -t ${shellEscape(`=${LEGACY_RUST_AGENT_SESSION}:`)} 2>/dev/null || true`,
        `tmux new-session -d -s ${shellEscape(RUST_AGENT_SESSION)} ${shellEscape(`bash -l -c ${shellEscape(expectedAgentCommand)}`)}`,
      ].join('; '),
    ]);
  });

  it('keeps the Node fallback session alive for one-shot Rust agent recovery', async () => {
    mockExecFile.mockImplementation(resolveExec());

    const result = await recoverRemoteAgent('candide', 'rust', { origin: 'candide', once: true });

    expect(result).toEqual({
      sshHost: 'candide',
      tunnel: 'reachable',
      agent: 'restarted',
      message: 'candide: tunnel already reachable; restarted portolan-agent-rust',
    });
    const expectedAgentCommand = `~/.local/bin/portolan-agent-rust connect --ssh-host=${shellEscape('candide')} --origin=${shellEscape('candide')} --once`;
    expect(mockExecFile.mock.calls[1]?.[1]).toEqual([
      '-T',
      'candide',
      [
        `tmux kill-session -t ${shellEscape(`=${RUST_AGENT_SESSION}:`)} 2>/dev/null || true`,
        `tmux new-session -d -s ${shellEscape(RUST_AGENT_SESSION)} ${shellEscape(`bash -l -c ${shellEscape(expectedAgentCommand)}`)}`,
      ].join('; '),
    ]);
  });

  it('defaults recovery to the Rust agent when no runtime is supplied', async () => {
    mockExecFile.mockImplementation(resolveExec());

    const result = await recoverRemoteAgent('candide');

    expect(result).toEqual({
      sshHost: 'candide',
      tunnel: 'reachable',
      agent: 'restarted',
      message: 'candide: tunnel already reachable; restarted portolan-agent-rust',
    });
    expect((mockExecFile.mock.calls[1]?.[1] as string[])[2]).toContain(
      `tmux kill-session -t ${shellEscape(`=${NODE_AGENT_SESSION}:`)} 2>/dev/null || true`,
    );
    expect((mockExecFile.mock.calls[1]?.[1] as string[])[2]).toContain(
      `tmux new-session -d -s ${shellEscape(RUST_AGENT_SESSION)}`,
    );
  });

  it('reports explicit Node agent restart failures without restarting a healthy tunnel', async () => {
    mockExecFile
      .mockImplementationOnce(resolveExec())
      .mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(new Error('tmux refused'), '', 'tmux refused');
        return {} as any;
      });

    const result = await recoverRemoteAgent('candide', 'node');

    expect(result).toEqual({
      sshHost: 'candide',
      tunnel: 'reachable',
      agent: 'failed',
      message: 'candide: tunnel already reachable; failed to restart portolan-agent: tmux refused',
    });
    expect(mockExecFile.mock.calls.some((call) => call[0] === 'launchctl')).toBe(false);
    expect((mockExecFile.mock.calls[1]?.[1] as string[])[2]).toContain(
      `tmux kill-session -t ${shellEscape(`=${NODE_AGENT_SESSION}:`)} 2>/dev/null || true`,
    );
    expect((mockExecFile.mock.calls[1]?.[1] as string[])[2]).toContain(
      `tmux kill-session -t ${shellEscape(`=${RUST_AGENT_SESSION}:`)} 2>/dev/null || true`,
    );
    expect((mockExecFile.mock.calls[1]?.[1] as string[])[2]).toContain(
      `tmux kill-session -t ${shellEscape(`=${LEGACY_RUST_AGENT_SESSION}:`)} 2>/dev/null || true`,
    );
  });
});
