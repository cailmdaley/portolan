import { describe, expect, it, vi } from 'vitest';
import { OriginManager } from '../OriginManager.js';

function makeSocket() {
  return {
    close: vi.fn(),
  } as any;
}

describe('OriginManager', () => {
  it('evicts older agent sockets when the same origin reconnects', () => {
    const manager = new OriginManager();
    const firstSocket = makeSocket();
    const secondSocket = makeSocket();

    const firstOrigin = manager.registerAgent('candide', firstSocket, 'candide');
    expect(firstOrigin.agentSockets.size).toBe(1);

    const secondOrigin = manager.registerAgent('candide', secondSocket, 'candide');

    expect(firstSocket.close).toHaveBeenCalledTimes(1);
    expect(secondOrigin.agentSockets.size).toBe(1);
    expect(secondOrigin.agentSockets.has(secondSocket)).toBe(true);
    expect(manager.isOriginConnected(secondOrigin.id)).toBe(true);
  });

  it('retains only the latest runtime registration per origin', () => {
    const manager = new OriginManager();
    const firstSocket = makeSocket();
    const secondSocket = makeSocket();

    const firstOrigin = manager.registerAgent('candide', firstSocket, 'candide', undefined, 'node');
    expect(firstOrigin.agentRuntime).toBe('node');

    const secondOrigin = manager.registerAgent('candide', secondSocket, 'candide', undefined, 'rust');
    expect(firstSocket.close).toHaveBeenCalledTimes(1);
    expect(secondOrigin.agentRuntime).toBe('rust');
    expect(secondOrigin.agentSockets.size).toBe(1);

    expect(manager.handleDisconnect(firstSocket)).toBeNull();
    expect(manager.isOriginConnected(secondOrigin.id)).toBe(true);

    const fullyDisconnected = manager.handleDisconnect(secondSocket);
    expect(fullyDisconnected).not.toBeNull();
    expect(fullyDisconnected?.agentRuntime).toBe('rust');
    expect(fullyDisconnected?.sshHost).toBe('candide');
  });
});
