import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'child_process';
import { KittySessionController } from '../KittySessionController.js';
import type { Origin } from '../OriginManager.js';
import type { Session } from '../SessionTracker.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
}));

const mockExecSync = childProcess.execSync as unknown as ReturnType<typeof vi.fn>;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    tmuxSession: 'worker-1',
    cwd: '/tmp/project',
    status: 'idle',
    cityId: 'city-1',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    name: 'worker-1',
    originId: 'local',
    ...overrides,
  };
}

function makeOrigin(overrides: Partial<Origin> = {}): Origin {
  return {
    id: 'remote-hpc',
    name: 'hpc',
    type: 'remote',
    sshHost: 'login.example',
    position: { q: 0, r: 0 },
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    agentSockets: new Set(),
    ...overrides,
  };
}

describe('KittySessionController', () => {
  const activateKitty = vi.fn();

  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from(''));
    activateKitty.mockReset();
  });

  it('focuses an existing local kitty tab before activating kitty', () => {
    const controller = new KittySessionController({
      sessionLookup: {
        findSession: () => makeSession(),
      },
      originLookup: {
        getOrigin: () => null,
      },
      getSocket: () => 'unix:/tmp/kitty-socket',
      getSshAuthSockEnv: () => '',
      activateKitty,
    });

    controller.focusSession('session-1');

    expect(mockExecSync).toHaveBeenCalledWith(
      "kitty @ --to unix:/tmp/kitty-socket focus-tab --match title:'^worker-1$'",
      { stdio: 'ignore' }
    );
    expect(activateKitty).toHaveBeenCalledTimes(1);
  });

  it('launches a local kitty tab when focus fails', () => {
    mockExecSync
      .mockImplementationOnce(() => {
        throw new Error('missing tab');
      })
      .mockImplementationOnce(() => Buffer.from(''));

    const controller = new KittySessionController({
      sessionLookup: {
        findSession: () => makeSession(),
      },
      originLookup: {
        getOrigin: () => null,
      },
      getSocket: () => 'unix:/tmp/kitty-socket',
      getSshAuthSockEnv: () => '',
      activateKitty,
    });

    controller.focusSession('session-1');

    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      "kitty @ --to unix:/tmp/kitty-socket launch --type=tab --cwd='/tmp/project' --title='worker-1' tmux attach -t 'worker-1'",
      { stdio: 'ignore' }
    );
    expect(activateKitty).toHaveBeenCalledTimes(1);
  });

  it('launches a remote kitty tab with ssh auth forwarding when focus fails', () => {
    mockExecSync
      .mockImplementationOnce(() => {
        throw new Error('missing tab');
      })
      .mockImplementationOnce(() => Buffer.from(''));

    const controller = new KittySessionController({
      sessionLookup: {
        findSession: () => makeSession({
          originId: 'remote-hpc',
          tmuxSession: 'worker-remote',
        }),
      },
      originLookup: {
        getOrigin: () => makeOrigin(),
      },
      getSocket: () => 'unix:/tmp/kitty-socket',
      getSshAuthSockEnv: () => '--env SSH_AUTH_SOCK=/tmp/agent.sock',
      activateKitty,
    });

    controller.focusSession('session-1');

    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      "kitty @ --to unix:/tmp/kitty-socket launch --type=tab --env SSH_AUTH_SOCK=/tmp/agent.sock --title='worker-remote@hpc' ssh -tt 'login.example' tmux attach -t 'worker-remote'",
      { stdio: 'ignore' }
    );
    expect(activateKitty).toHaveBeenCalledTimes(1);
  });

  it('kills a remote worker through ssh', () => {
    const controller = new KittySessionController({
      sessionLookup: {
        findSession: () => makeSession({
          originId: 'remote-hpc',
          tmuxSession: 'worker-remote',
        }),
      },
      originLookup: {
        getOrigin: () => makeOrigin(),
      },
      getSocket: () => 'unix:/tmp/kitty-socket',
      getSshAuthSockEnv: () => '',
      activateKitty,
    });

    controller.killWorker('session-1');

    expect(mockExecSync).toHaveBeenCalledWith(
      "ssh login.example 'tmux kill-session -t '\\''worker-remote'\\'''",
      { stdio: 'pipe', timeout: 10000 }
    );
  });
});
