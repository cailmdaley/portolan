import type { ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';

import type { City } from '../CityManager.js';
import { HttpApiActivation } from '../HttpApiActivation.js';
import type { RemoteAgentRuntimePreference, RemoteAgentRuntimePreferences } from '../RemoteAgentRuntimePreferenceStore.js';
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

function runtimePreferences(initial: Record<string, 'node' | 'rust'> = {}): RemoteAgentRuntimePreferences {
  const values = new Map(Object.entries(initial));
  return {
    getDefaultRuntime: () => 'rust',
    getPreferredRuntime: (sshHost) => values.get(sshHost),
    setPreferredRuntime: (sshHost, runtime) => {
      values.set(sshHost, runtime);
    },
    getDiagnostics: () => ({
      defaultRuntime: 'rust',
      preferences: Array.from(values.entries()).map(([sshHost, runtime]): RemoteAgentRuntimePreference => ({
        sshHost,
        runtime,
        updatedAt: '2026-05-13T00:00:00.000Z',
      })),
    }),
  };
}

describe('HttpApiActivation', () => {
  it('starts the Node agent with the Node runtime tmux session', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
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

    expect(reconnectTunnelFn).not.toHaveBeenCalled();
    expect(execFileFn).toHaveBeenCalledTimes(4);
    expect(execFileFn.mock.calls[0]?.[1]).toEqual([
      '-T',
      sshHost,
      'curl -sS --connect-timeout 3 http://localhost:4004/debug-runtime >/dev/null',
    ]);
    expect(execFileFn.mock.calls[1]?.[1]).toEqual([
      '-T',
      sshHost,
      `tmux has-session -t ${exactTmuxTarget('portolan-agent')} 2>/dev/null && echo running || echo stopped`,
    ]);
    expect(execFileFn.mock.calls[2]?.[1]).toEqual([
      '-T',
      sshHost,
      `tmux kill-session -t ${exactTmuxTarget('portolan-agent-rust-preview')} 2>/dev/null || true`,
    ]);
    const startArgs = execFileFn.mock.calls[3]?.[1] as string[];
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
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
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

    expect(reconnectTunnelFn).not.toHaveBeenCalled();
    expect(execFileFn).toHaveBeenCalledTimes(4);
    expect(execFileFn.mock.calls[0]?.[1]).toEqual([
      '-T',
      unsafeHost,
      'curl -sS --connect-timeout 3 http://localhost:4004/debug-runtime >/dev/null',
    ]);
    expect(execFileFn.mock.calls[1]?.[1]).toEqual([
      '-T',
      unsafeHost,
      `tmux has-session -t ${exactTmuxTarget('portolan-agent-rust-preview')} 2>/dev/null && echo running || echo stopped`,
    ]);
    expect(execFileFn.mock.calls[2]?.[1]).toEqual([
      '-T',
      unsafeHost,
      `tmux kill-session -t ${exactTmuxTarget('portolan-agent')} 2>/dev/null || true`,
    ]);
    const startArgs = execFileFn.mock.calls[3]?.[1] as string[];
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

  it('uses the host runtime preference when the request omits agentRuntime', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const preferences = runtimePreferences({ candide: 'rust' });
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      reconnectTunnelFn: vi.fn().mockResolvedValue(undefined),
      execFileFn: execFileFn as any,
      runtimePreferences: preferences,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(new URL('http://localhost/activate-city?cityId=remote-city'), res);

    expect(execFileFn.mock.calls[1]?.[1]).toEqual([
      '-T',
      'candide',
      `tmux has-session -t ${exactTmuxTarget('portolan-agent-rust-preview')} 2>/dev/null && echo running || echo stopped`,
    ]);
    expect(execFileFn.mock.calls[2]?.[1]).toEqual([
      '-T',
      'candide',
      `tmux kill-session -t ${exactTmuxTarget('portolan-agent')} 2>/dev/null || true`,
    ]);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'started',
        message: 'rust agent started on candide (portolan-agent-rust-preview)',
        preferredRuntime: 'rust',
      },
    });
  });

  it('treats a duplicate runtime tmux session during start as already running', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('duplicate session: portolan-agent-rust-preview'));
    const preferences = runtimePreferences({ candide: 'rust' });
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      reconnectTunnelFn: vi.fn().mockResolvedValue(undefined),
      execFileFn: execFileFn as any,
      runtimePreferences: preferences,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(new URL('http://localhost/activate-city?cityId=remote-city'), res);

    expect(execFileFn).toHaveBeenCalledTimes(4);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'already_running',
        message: 'Agent (rust) already running on candide',
        preferredRuntime: 'rust',
      },
    });
  });

  it('uses the configured default runtime when no host preference exists', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      reconnectTunnelFn: vi.fn().mockResolvedValue(undefined),
      execFileFn: execFileFn as any,
      runtimePreferences: runtimePreferences(),
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(new URL('http://localhost/activate-city?cityId=remote-city'), res);

    expect(execFileFn.mock.calls[1]?.[1]).toEqual([
      '-T',
      'candide',
      `tmux has-session -t ${exactTmuxTarget('portolan-agent-rust-preview')} 2>/dev/null && echo running || echo stopped`,
    ]);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'started',
        message: 'rust agent started on candide (portolan-agent-rust-preview)',
        preferredRuntime: 'rust',
      },
    });
  });

  it('accepts rust preview activation options from request body', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const reconnectTunnelFn = vi.fn().mockResolvedValue(undefined);
    const remoteCity = city();
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(remoteCity) },
      getSshHost: () => 'candide',
      reconnectTunnelFn,
      execFileFn: execFileFn as any,
    });
    const { res, result } = captureResponse();
    const body = {
      cityId: 'remote-city',
      agentRuntime: 'rust',
      origin: "candide' ; touch /tmp/x",
      plannotatorPort: 50055,
      once: true,
    };

    await api.handleActivateCity(new URL('http://localhost/activate-city'), res, body);

    expect(reconnectTunnelFn).not.toHaveBeenCalled();
    expect(execFileFn).toHaveBeenCalledTimes(3);
    const startArgs = execFileFn.mock.calls[2]?.[1] as string[];
    const escapedOrigin = shellEscape(body.origin);
    const expectedStartCommand = `~/.local/bin/portolan-agent-rust connect --ssh-host=${shellEscape('candide')} --origin=${escapedOrigin} --plannotator-port=${shellEscape('50055')} --once`;
    const expectedRemoteCommand = `tmux new-session -d -s ${shellEscape('portolan-agent-rust-preview')} ${shellEscape(`bash -l -c ${shellEscape(expectedStartCommand)}`)}`;
    expect(startArgs[0]).toBe('-T');
    expect(startArgs[1]).toBe('candide');
    expect(startArgs[2]).toBe(expectedRemoteCommand);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'started',
        message: 'rust agent started on candide (portolan-agent-rust-preview)',
      },
    });
  });

  it('does not persist one-shot Rust preview as the host preference', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const preferences = runtimePreferences({ candide: 'node' });
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      reconnectTunnelFn: vi.fn().mockResolvedValue(undefined),
      execFileFn: execFileFn as any,
      runtimePreferences: preferences,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(
      new URL('http://localhost/activate-city'),
      res,
      {
        cityId: 'remote-city',
        agentRuntime: 'rust',
        once: true,
      },
    );

    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'started',
        message: 'rust agent started on candide (portolan-agent-rust-preview)',
        preferredRuntime: 'node',
      },
    });
  });

  it('persists explicit Node activation as rollback from a Rust preference', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const preferences = runtimePreferences({ candide: 'rust' });
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      reconnectTunnelFn: vi.fn().mockResolvedValue(undefined),
      execFileFn: execFileFn as any,
      runtimePreferences: preferences,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(
      new URL('http://localhost/activate-city?cityId=remote-city&agentRuntime=node'),
      res,
    );

    expect(execFileFn.mock.calls[1]?.[1]).toEqual([
      '-T',
      'candide',
      `tmux has-session -t ${exactTmuxTarget('portolan-agent')} 2>/dev/null && echo running || echo stopped`,
    ]);
    expect(execFileFn.mock.calls[2]?.[1]).toEqual([
      '-T',
      'candide',
      `tmux kill-session -t ${exactTmuxTarget('portolan-agent-rust-preview')} 2>/dev/null || true`,
    ]);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'started',
        message: 'node agent started on candide (portolan-agent)',
        preferredRuntime: 'node',
      },
    });
  });

  it('rejects invalid rust preview plannotator port payload', async () => {
    const api = new HttpApiActivation({
      cityLookup: { getCityById: vi.fn().mockReturnValue(city()) },
      getSshHost: () => 'candide',
      execFileFn: vi.fn() as any,
    });
    const { res, result } = captureResponse();

    await api.handleActivateCity(
      new URL('http://localhost/activate-city'),
      res,
      {
        cityId: 'remote-city',
        agentRuntime: 'rust',
        plannotatorPort: 'nope',
      },
    );

    expect(result()).toEqual({
      status: 400,
      body: {
        error: 'Invalid plannotatorPort: nope',
      },
    });
  });

  it('kickstarts the tunnel only after the remote backend probe fails', async () => {
    const execFileFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('remote backend unavailable'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'running\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
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

    expect(reconnectTunnelFn).toHaveBeenCalledWith('candide');
    expect(execFileFn).toHaveBeenCalledTimes(4);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'already_running',
        message: 'Agent (rust) already running on candide',
      },
    });
  });

  it('does not start a second runtime-specific session when one is already running', async () => {
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'running\n', stderr: '' });
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

    expect(execFileFn).toHaveBeenCalledTimes(3);
    expect(execFileFn.mock.calls[2]?.[1]).toEqual([
      '-T',
      'candide',
      `tmux kill-session -t ${exactTmuxTarget('portolan-agent')} 2>/dev/null || true`,
    ]);
    expect(result()).toEqual({
      status: 200,
      body: {
        status: 'already_running',
        message: 'Agent (rust) already running on candide',
      },
    });
  });
});
