import { describe, expect, it, vi } from 'vitest';
import { AgentAwareMeetingMessenger } from '../AgentAwareMeetingMessenger.js';

describe('AgentAwareMeetingMessenger', () => {
  it('uses the fallback messenger for local targets', () => {
    const remoteSender = vi.fn();
    const fallback = { send: vi.fn() };
    const messenger = new AgentAwareMeetingMessenger(remoteSender, fallback);

    messenger.send(
      { tmuxSession: 'local-worker', originId: 'local', cwd: '/project' },
      'bootstrap',
      { pressEnter: true },
    );

    expect(remoteSender).not.toHaveBeenCalled();
    expect(fallback.send).toHaveBeenCalledWith(
      { tmuxSession: 'local-worker', originId: 'local', cwd: '/project' },
      'bootstrap',
      { pressEnter: true },
    );
  });

  it('sends remote meeting bootstrap prompts through the connected agent path', async () => {
    const remoteSender = vi.fn(async () => undefined);
    const fallback = { send: vi.fn() };
    const messenger = new AgentAwareMeetingMessenger(remoteSender, fallback);

    messenger.send(
      {
        tmuxSession: 'remote-worker',
        originId: 'remote-candide',
        cwd: '/home/cdaley/project',
        sshHost: 'candide',
      },
      'meeting bootstrap',
      { pressEnter: true },
    );
    await Promise.resolve();

    expect(remoteSender).toHaveBeenCalledWith({
      originId: 'remote-candide',
      tmuxSession: 'remote-worker',
      message: 'meeting bootstrap',
      pressEnter: true,
    });
    expect(fallback.send).not.toHaveBeenCalled();
  });

  it('falls back for clear remote agent failures', async () => {
    const remoteSender = vi.fn(async () => {
      throw new Error('agent returned not found');
    });
    const fallback = { send: vi.fn() };
    const messenger = new AgentAwareMeetingMessenger(remoteSender, fallback);

    messenger.send(
      {
        tmuxSession: 'remote-worker',
        originId: 'remote-candide',
        cwd: '/home/cdaley/project',
        sshHost: 'candide',
      },
      'meeting bootstrap',
      { pressEnter: true },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fallback.send).toHaveBeenCalledWith(
      {
        tmuxSession: 'remote-worker',
        originId: 'remote-candide',
        cwd: '/home/cdaley/project',
        sshHost: 'candide',
      },
      'meeting bootstrap',
      { pressEnter: true },
    );
  });

  it('does not fallback after ambiguous remote agent delivery failures', async () => {
    const remoteSender = vi.fn(async () => {
      throw new Error('remote agent timed out before acknowledge');
    });
    const fallback = { send: vi.fn() };
    const messenger = new AgentAwareMeetingMessenger(remoteSender, fallback);

    messenger.send(
      {
        tmuxSession: 'remote-worker',
        originId: 'remote-candide',
        cwd: '/home/cdaley/project',
        sshHost: 'candide',
      },
      'meeting bootstrap',
      { pressEnter: true },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fallback.send).not.toHaveBeenCalled();
  });
});
