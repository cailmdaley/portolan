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

  it('defaults omitted runtime registrations to rust and reports rust diagnostics', () => {
    const manager = new OriginManager();
    const socket = makeSocket();

    const origin = manager.registerAgent('candide', socket, 'candide');

    expect(origin.agentRuntime).toBe('rust');
    expect(manager.getConnectedRemoteAgentDiagnostics()).toEqual([
      expect.objectContaining({
        originId: 'remote-candide',
        agentRuntime: 'rust',
      }),
    ]);
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

  it('stores and clears one-shot agent registrations per origin', () => {
    const manager = new OriginManager();
    const firstSocket = makeSocket();
    const secondSocket = makeSocket();

    const firstOrigin = manager.registerAgent('candide', firstSocket, 'candide', undefined, 'rust', true);
    expect(firstOrigin.agentRuntime).toBe('rust');
    expect(firstOrigin.agentOnce).toBe(true);

    const secondOrigin = manager.registerAgent('candide', secondSocket, 'candide', undefined, 'rust');
    expect(firstSocket.close).toHaveBeenCalledTimes(1);
    expect(secondOrigin.agentOnce).toBe(false);
  });

  it('reports connected remote agent runtime diagnostics', () => {
    const manager = new OriginManager();
    const firstSocket = makeSocket();
    const secondSocket = makeSocket();

    manager.registerAgent('cineca', firstSocket, 'cineca-login05', 50055, 'rust', true);
    manager.registerAgent('candide', secondSocket, 'candide', undefined, 'node');

    expect(manager.getConnectedRemoteAgentDiagnostics()).toEqual([
      expect.objectContaining({
        originId: 'remote-candide',
        name: 'candide',
        sshHost: 'candide',
        agentRuntime: 'node',
        agentOnce: false,
        plannotatorPort: null,
        socketCount: 1,
      }),
      expect.objectContaining({
        originId: 'remote-cineca',
        name: 'cineca',
        sshHost: 'cineca-login05',
        agentRuntime: 'rust',
        agentOnce: true,
        plannotatorPort: 50055,
        socketCount: 1,
      }),
    ]);

    expect(manager.getConnectedRemoteAgentDiagnostics()[0].connectedAt).toMatch(/T/);
    manager.handleDisconnect(secondSocket);
    expect(manager.getConnectedRemoteAgentDiagnostics().map((entry) => entry.originId)).toEqual([
      'remote-cineca',
    ]);
  });
});
