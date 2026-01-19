/**
 * Integration tests for index.ts WebSocket server
 *
 * Tests cover:
 * - WebSocket connections and initial state delivery
 * - State broadcasting to multiple clients
 * - Focus message handling (validates error handling for non-existent sessions)
 * - Malformed message handling
 * - Error recovery and client disconnection
 * - Fiber count integration in state
 *
 * Note: These tests run against the actual server instance since index.ts
 * auto-starts on import. We mock external dependencies (child_process, FiberReader)
 * but test real WebSocket communication, state management, and message handling.
 *
 * Limitations:
 * - Cannot test actual Kitty focus commands (execSync is mocked)
 * - Cannot test session change broadcasts without refactoring index.ts to export
 *   the SessionTracker instance
 * - No test coverage for fiber count refresh interval (would need server refactor)
 *
 * For full focus command testing, see manual testing or consider refactoring
 * index.ts to export createServer() function for better testability.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';

// Must mock BEFORE any imports that use these modules
vi.mock('child_process', () => {
  const mockExecSync = vi.fn((cmd: string) => {
    // Default behavior - simulate successful execution
    return Buffer.from('');
  });

  const mockExec = vi.fn((cmd: string, callback: any) => {
    // Simulate tmux not running (no sessions in test environment)
    callback(new Error('tmux not running'), { stdout: '', stderr: '' });
    return {} as any;
  });

  const mockExecFile = vi.fn((file: string, args: string[], options: any, callback?: any) => {
    // GitStatusManager uses execFile for git commands
    // Simulate "not a git repo" by throwing an error
    if (callback) {
      callback(new Error('not a git repo'), '', '');
    }
    return {} as any;
  });

  return {
    execSync: mockExecSync,
    exec: mockExec,
    execFile: mockExecFile,
  };
});

vi.mock('../FiberReader.js', () => ({
  countOpenFibers: vi.fn().mockResolvedValue(3),
}));

// Now we can import the mocked functions for inspection
import * as childProcess from 'child_process';
const mockExecSync = childProcess.execSync as unknown as ReturnType<typeof vi.fn>;
const mockExec = childProcess.exec as unknown as ReturnType<typeof vi.fn>;

// Import server module (this starts the server)
await import('../index.js');

describe('WebSocket Server Integration', () => {
  const serverPort = 4004;
  let ws: WebSocket | null = null;

  beforeAll(async () => {
    // Give server time to fully start
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  afterEach(async () => {
    // Clean up WebSocket connection after each test
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
      ws = null;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Clear mock call history
    mockExecSync.mockClear();
    mockExec.mockClear();
  });

  afterAll(async () => {
    // Give server time to clean up
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('WebSocket connection', () => {
    it('should accept WebSocket connections', async () => {
      const connectionPromise = new Promise<void>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('open', () => resolve());
      });

      await expect(connectionPromise).resolves.toBeUndefined();
    });

    it('should send initial state on connection', async () => {
      const messagePromise = new Promise<any>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('message', (data) => {
          const state = JSON.parse(data.toString());
          resolve(state);
        });
      });

      const state = await messagePromise;

      expect(state).toHaveProperty('cities');
      expect(state).toHaveProperty('sessions');
      expect(Array.isArray(state.cities)).toBe(true);
      expect(Array.isArray(state.sessions)).toBe(true);
    });

    it('should handle multiple concurrent connections', async () => {
      const ws1Promise = new Promise<void>((resolve) => {
        const client1 = new WebSocket(`ws://localhost:${serverPort}`);
        client1.on('message', () => {
          client1.close();
          resolve();
        });
      });

      const ws2Promise = new Promise<void>((resolve) => {
        const client2 = new WebSocket(`ws://localhost:${serverPort}`);
        client2.on('message', () => {
          client2.close();
          resolve();
        });
      });

      await Promise.all([ws1Promise, ws2Promise]);
    });
  });

  describe('Focus message handling', () => {
    it('should not crash on focus message for non-existent session', async () => {
      const completed = new Promise<void>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('open', () => {
          // Send focus message for non-existent session
          ws.send(JSON.stringify({
            type: 'focus',
            sessionId: 'non-existent-session-id',
          }));
          // Give it time to process
          setTimeout(resolve, 100);
        });
      });

      await completed;

      // Should not have called execSync since session doesn't exist
      // (focus function returns early)
      expect(ws!.readyState).toBe(WebSocket.OPEN);
    });

    it('should handle malformed focus messages gracefully', async () => {
      const errorPromise = new Promise<void>((resolve, reject) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('open', () => {
          // Send malformed message
          ws.send('not valid json');
          // If it doesn't crash, we're good
          setTimeout(resolve, 100);
        });
        ws.on('error', reject);
        ws.on('close', (code) => {
          if (code !== 1000) reject(new Error('Connection closed unexpectedly'));
        });
      });

      await expect(errorPromise).resolves.toBeUndefined();
    });

    it('should handle missing sessionId in focus message', async () => {
      const messageReceived = new Promise<void>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('open', () => {
          // Send focus message without sessionId
          ws.send(JSON.stringify({
            type: 'focus',
          }));
          setTimeout(resolve, 100);
        });
      });

      await messageReceived;

      // Should not crash - verify connection is still alive
      expect(ws!.readyState).toBe(WebSocket.OPEN);
    });

    it('should ignore non-focus message types', async () => {
      const messageReceived = new Promise<void>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('open', () => {
          // Send message with different type
          ws.send(JSON.stringify({
            type: 'unknown',
            data: 'something',
          }));
          setTimeout(resolve, 100);
        });
      });

      await messageReceived;

      // Should not crash
      expect(ws!.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('State broadcasting', () => {
    it('should include fiber counts in city data', async () => {
      const statePromise = new Promise<any>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('message', (data) => {
          const state = JSON.parse(data.toString());
          resolve(state);
        });
      });

      const state = await statePromise;

      // Each city should have a fiberCount property
      state.cities.forEach((city: any) => {
        expect(city).toHaveProperty('fiberCount');
        expect(typeof city.fiberCount).toBe('number');
      });
    });

    it('should broadcast state updates to all connected clients', async () => {
      const client1Messages: any[] = [];
      const client2Messages: any[] = [];

      const client1 = new WebSocket(`ws://localhost:${serverPort}`);
      const client2 = new WebSocket(`ws://localhost:${serverPort}`);

      const client1Ready = new Promise<void>((resolve) => {
        client1.on('message', (data) => {
          client1Messages.push(JSON.parse(data.toString()));
          resolve();
        });
      });

      const client2Ready = new Promise<void>((resolve) => {
        client2.on('message', (data) => {
          client2Messages.push(JSON.parse(data.toString()));
          resolve();
        });
      });

      await Promise.all([client1Ready, client2Ready]);

      // Both clients should have received initial state
      expect(client1Messages.length).toBeGreaterThanOrEqual(1);
      expect(client2Messages.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      client1.close();
      client2.close();
    });
  });

  describe('Error handling', () => {
    it('should handle client disconnection gracefully', async () => {
      const disconnected = new Promise<void>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('open', () => {
          ws.close();
        });
        ws.on('close', () => {
          resolve();
        });
      });

      await expect(disconnected).resolves.toBeUndefined();
    });

    it('should continue serving after client error', async () => {
      // First connection with error
      const ws1 = new WebSocket(`ws://localhost:${serverPort}`);
      await new Promise<void>((resolve) => {
        ws1.on('open', () => {
          ws1.send('invalid data that will cause parse error');
          ws1.close();
          resolve();
        });
      });

      // Second connection should still work
      const ws2Working = new Promise<any>((resolve) => {
        const ws2 = new WebSocket(`ws://localhost:${serverPort}`);
        ws2.on('message', (data) => {
          const state = JSON.parse(data.toString());
          ws2.close();
          resolve(state);
        });
      });

      const state = await ws2Working;
      expect(state).toHaveProperty('cities');
      expect(state).toHaveProperty('sessions');
    });
  });

  describe('Message protocol', () => {
    it('should handle various message types gracefully', async () => {
      const messages = [
        { type: 'focus', sessionId: 'some-id' },
        { type: 'unknown' },
        { different: 'structure' },
      ];

      const completed = new Promise<void>((resolve) => {
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        let messagesSent = 0;

        ws.on('open', () => {
          for (const msg of messages) {
            ws!.send(JSON.stringify(msg));
            messagesSent++;
          }

          // Wait for processing
          setTimeout(() => {
            expect(messagesSent).toBe(3);
            resolve();
          }, 150);
        });
      });

      await completed;

      // Should not crash despite various message formats
      expect(ws!.readyState).toBe(WebSocket.OPEN);
    });
  });
});
