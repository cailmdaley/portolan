import type { ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';

import type { City } from '../CityManager.js';
import { HttpApiActivation } from '../HttpApiActivation.js';
import { exactTmuxTarget, shellEscape } from '../ShellPathUtils.js';

function city(overrides: Partial<City> = {}): City {
  return {
    id: 'remote-city',
    path: '/remote/project',
    name: 'remote project',
    position: { q: 4, r: 1 },
    originId: 'remote-candide',
    ...overrides,
  };
}

function captureResponse() {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
    },
  } as unknown as ServerResponse;

  return {
    res,
    result() {
      const raw = chunks.join('');
      return { status, body: raw ? JSON.parse(raw) : null };
    },
  };
}

describe('HttpApiActivation', () => {
  it('starts the Node agent with the Node runtime tmux session', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const reconnectTunnelFn = vi.fn().mockResolvedValue(undefined);
    const remoteCity = city();
    const sshHost = 'candide';
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(remoteCity) },
      getSshHost: () => sshHost,
      reconnectTunnelFn,
      execFileFn: execFileFn as any,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(
      new URL('http://localhost/activate-city?cityId=remote-city&agentRuntime=node'),
      res,
    );

    expect(reconnectTunnelFn).toHaveBeenCalledWith('candide');
    expect(execFileFn).toHaveBeenCalledTimes(2);
    expect(execFileFn.mock.calls[0]?.[1]).toEqual([
      '-T',
      sshHost,
      `tmux has-session -t ${exactTmuxTarget('portolan-agent')} 2>/dev/null && echo running || echo stopped`,
    ]);
    const startArgs = execFileFn.mock.calls[1]?.[1] as string[];
    const expectedStartCommand = `node ~/.local/bin/portolan-agent.js connect --ssh-host=${shellEscape(sshHost)}`;
    const expectedCommand = `tmux new-session -d -s ${shellEscape('portolan-agent')} ${shellEscape(`bash -l -c ${shellEscape(expectedStartCommand)}`)}`;
    expect(startArgs[0]).toBe('-T');
    expect(startArgs[1]).toBe(sshHost);
    expect(startArgs[2]).toBe(expectedCommand);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'started',
        message: `node agent started on ${sshHost} (portolan-agent)`,
      },
    });
  });

  it('rejects unsupported runtime identifiers', async () => {
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      execFileFn: vi.fn() as any,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(
      new URL('http://localhost/activate-city?cityId=remote-city&agentRuntime=python'),
      res,
    );

    expect(result()).toEqual({
      status: 400,
      body: {
        error: 'Invalid agent runtime: python',
      },
    });
  });

  it('starts the Rust preview agent with shell-escaped remote tmux command', async () => {
    const unsafeHost = "candide'; touch /tmp/pwn; echo 'x";
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const reconnectTunnelFn = vi.fn().mockResolvedValue(undefined);
    const remoteCity = city();
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(remoteCity) },
      getSshHost: () => unsafeHost,
      reconnectTunnelFn,
      execFileFn: execFileFn as any,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(
      new URL('http://localhost/activate-city?cityId=remote-city&agentRuntime=rust'),
      res,
    );

    expect(reconnectTunnelFn).toHaveBeenCalledWith(unsafeHost);
    expect(execFileFn).toHaveBeenCalledTimes(2);
    expect(execFileFn.mock.calls[0]?.[1]).toEqual([
      '-T',
      unsafeHost,
      `tmux has-session -t ${exactTmuxTarget('portolan-agent-rust-preview')} 2>/dev/null && echo running || echo stopped`,
    ]);
    const startArgs = execFileFn.mock.calls[1]?.[1] as string[];
    const escapedStartCommand = `~/.local/bin/portolan-agent-rust connect --ssh-host=${shellEscape(unsafeHost)}`;
    const expectedRemoteCommand = `tmux new-session -d -s ${shellEscape('portolan-agent-rust-preview')} ${shellEscape(`bash -l -c ${shellEscape(escapedStartCommand)}`)}`;
    expect(startArgs[0]).toBe('-T');
    expect(startArgs[1]).toBe(unsafeHost);
    expect(startArgs[2]).toBe(expectedRemoteCommand);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'started',
        message: `rust agent started on ${unsafeHost} (portolan-agent-rust-preview)`,
      },
    });
  });

  it('does not start a second runtime-specific session when one is already running', async () => {
    const execFileFn = vi.fn().mockResolvedValueOnce({ stdout: 'running\n', stderr: '' });
    const reconnectTunnelFn = vi.fn().mockResolvedValue(undefined);
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      reconnectTunnelFn,
      execFileFn: execFileFn as any,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(
      new URL('http://localhost/activate-city?cityId=remote-city&agentRuntime=rust'),
      res,
    );

    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'already_running',
        message: 'Agent (rust) already running on candide',
      },
    });
  });
});
