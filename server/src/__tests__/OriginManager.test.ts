import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OriginManager } from '../OriginManager.js';
import { WebSocket } from 'ws';

// Mock WebSocket
function mockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    on: vi.fn(),
  } as unknown as WebSocket;
}

describe('OriginManager', () => {
  let originManager: OriginManager;

  beforeEach(() => {
    originManager = new OriginManager();
  });

  describe('initialization', () => {
    it('should have local origin by default', () => {
      const origins = originManager.getOrigins();
      expect(origins.length).toBe(1);
      expect(origins[0].id).toBe('local');
      expect(origins[0].type).toBe('local');
    });

    it('should place local origin at center', () => {
      const localOrigin = originManager.getOrigin('local');
      expect(localOrigin?.position).toEqual({ q: 0, r: 0 });
    });
  });

  describe('registerAgent', () => {
    it('should register new remote origin', () => {
      const ws = mockWs();
      const origin = originManager.registerAgent('server1', ws);

      expect(origin.id).toBe('remote-server1');
      expect(origin.name).toBe('server1');
      expect(origin.type).toBe('remote');
    });

    it('should assign compass position to new origin', () => {
      const ws = mockWs();
      const origin = originManager.registerAgent('server1', ws);

      // First remote should get position at one of the compass directions
      expect(origin.position).toBeDefined();
      expect(origin.position.q !== 0 || origin.position.r !== 0).toBe(true);
    });

    it('should track sshHost if provided', () => {
      const ws = mockWs();
      const origin = originManager.registerAgent('server1', ws, 'myserver.local');

      expect(origin.sshHost).toBe('myserver.local');
    });

    it('should use originName as sshHost if not provided', () => {
      const ws = mockWs();
      const origin = originManager.registerAgent('server1', ws);

      expect(origin.sshHost).toBe('server1');
    });

    it('should reuse existing origin on reconnection', () => {
      const ws1 = mockWs();
      const origin1 = originManager.registerAgent('server1', ws1);
      const firstPosition = origin1.position;

      // Simulate disconnect
      originManager.handleDisconnect(ws1);

      // Reconnect
      const ws2 = mockWs();
      const origin2 = originManager.registerAgent('server1', ws2);

      expect(origin2.id).toBe(origin1.id);
      expect(origin2.position).toEqual(firstPosition);
    });

    it('should support multiple agents from same origin', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      originManager.registerAgent('server1', ws1);
      originManager.registerAgent('server1', ws2);

      const origin = originManager.getOrigin('remote-server1');
      expect(origin?.agentSockets.size).toBe(2);
    });
  });

  describe('handleDisconnect', () => {
    it('should return disconnected origin when last socket disconnects', () => {
      const ws = mockWs();
      originManager.registerAgent('server1', ws);

      const disconnected = originManager.handleDisconnect(ws);

      expect(disconnected).not.toBeNull();
      expect(disconnected?.id).toBe('remote-server1');
    });

    it('should return null when other sockets still connected', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      originManager.registerAgent('server1', ws1);
      originManager.registerAgent('server1', ws2);

      const disconnected = originManager.handleDisconnect(ws1);

      expect(disconnected).toBeNull();
    });

    it('should return null for unknown socket', () => {
      const ws = mockWs();
      const disconnected = originManager.handleDisconnect(ws);

      expect(disconnected).toBeNull();
    });
  });

  describe('isOriginConnected', () => {
    it('should return true for local origin', () => {
      expect(originManager.isOriginConnected('local')).toBe(true);
    });

    it('should return true when origin has connected agent', () => {
      const ws = mockWs();
      originManager.registerAgent('server1', ws);

      expect(originManager.isOriginConnected('remote-server1')).toBe(true);
    });

    it('should return false when all agents disconnected', () => {
      const ws = mockWs();
      originManager.registerAgent('server1', ws);
      originManager.handleDisconnect(ws);

      expect(originManager.isOriginConnected('remote-server1')).toBe(false);
    });

    it('should return false for unknown origin', () => {
      expect(originManager.isOriginConnected('unknown')).toBe(false);
    });
  });

  describe('getOrigins', () => {
    it('should return all origins', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      originManager.registerAgent('server1', ws1);
      originManager.registerAgent('server2', ws2);

      const origins = originManager.getOrigins();

      expect(origins.length).toBe(3); // local + 2 remote
      expect(origins.map(o => o.id).sort()).toEqual(['local', 'remote-server1', 'remote-server2']);
    });
  });

  describe('compass positioning', () => {
    it('should place multiple origins at different positions', () => {
      const positions = new Set<string>();

      for (let i = 0; i < 4; i++) {
        const ws = mockWs();
        const origin = originManager.registerAgent(`server${i}`, ws);
        const key = `${origin.position.q},${origin.position.r}`;
        positions.add(key);
      }

      // All 4 remote origins should have unique positions
      expect(positions.size).toBe(4);
    });
  });
});
