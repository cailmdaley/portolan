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
});
