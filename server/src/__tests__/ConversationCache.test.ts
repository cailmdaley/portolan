import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationCache, CachedMessage } from '../ConversationCache.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConversationCache', () => {
  let cache: ConversationCache;
  let testPersistPath: string;

  beforeEach(() => {
    testPersistPath = join(tmpdir(), `conversation-test-${Date.now()}.json`);
    cache = new ConversationCache(testPersistPath);
  });

  afterEach(() => {
    cache.stop();
    if (existsSync(testPersistPath)) {
      unlinkSync(testPersistPath);
    }
  });

  describe('addMessages', () => {
    it('should add messages to a new session', () => {
      const messages: CachedMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ];

      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);
      const result = cache.getMessages('session-1');

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Hello');
    });

    it('should deduplicate by timestamp', () => {
      const messages: CachedMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ];

      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);
      const result = cache.getMessages('session-1');

      expect(result).toHaveLength(1);
    });

    it('should deduplicate timestamps with different precision (hooks vs transcripts)', () => {
      // Hooks generate timestamps without milliseconds (shell date command)
      const hookMessages: CachedMessage[] = [
        { type: 'user', content: 'From hook', timestamp: '2024-01-01T00:00:00Z' }
      ];
      // Transcripts have ISO timestamps with milliseconds — different precision = different message
      const transcriptMessages: CachedMessage[] = [
        { type: 'user', content: 'From transcript', timestamp: '2024-01-01T00:00:00.123Z' }
      ];

      cache.addMessages('session-1', 'tmux-1', '/test/cwd', hookMessages);
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', transcriptMessages);
      const result = cache.getMessages('session-1');

      // Exact timestamp dedup: different ms precision = different timestamps = both kept
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('From hook');
      expect(result[1].content).toBe('From transcript');
    });

    it('should skip invalid sessionIds', () => {
      const messages: CachedMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ];

      cache.addMessages('', 'tmux-1', '/test/cwd', messages);
      cache.addMessages('undefined', 'tmux-1', '/test/cwd', messages);

      expect(cache.getMessages('')).toHaveLength(0);
      expect(cache.getMessages('undefined')).toHaveLength(0);
    });

    it('should trim messages beyond maxMessagesPerSession', () => {
      const messages: CachedMessage[] = Array.from({ length: 150 }, (_, i) => ({
        type: 'user' as const,
        content: `Message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`
      }));

      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);
      const result = cache.getMessages('session-1');

      expect(result).toHaveLength(100);
      expect(result[0].content).toBe('Message 50'); // First 50 trimmed
    });

    it('should call messageCallback for new messages', () => {
      const callback = vi.fn();
      cache.onMessage(callback);

      const messages: CachedMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ];

      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);

      expect(callback).toHaveBeenCalledWith('session-1', 'tmux-1', messages);
    });

    it('should not call callback for duplicate messages', () => {
      const callback = vi.fn();
      cache.onMessage(callback);

      const messages: CachedMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ];

      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMessagesByTmux', () => {
    it('should aggregate messages from multiple sessions with same tmuxSession', () => {
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'First', timestamp: '2024-01-01T00:00:00Z' }
      ]);
      cache.addMessages('session-2', 'tmux-1', '/test/cwd', [
        { type: 'assistant', content: 'Second', timestamp: '2024-01-01T00:00:01Z' }
      ]);

      const result = cache.getMessagesByTmux('tmux-1');

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('First');
      expect(result[1].content).toBe('Second');
    });

    it('should not include messages from different tmuxSession', () => {
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'First', timestamp: '2024-01-01T00:00:00Z' }
      ]);
      cache.addMessages('session-2', 'tmux-2', '/test/cwd', [
        { type: 'assistant', content: 'Second', timestamp: '2024-01-01T00:00:01Z' }
      ]);

      const result = cache.getMessagesByTmux('tmux-1');

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('First');
    });

    it('should sort by timestamp and deduplicate', () => {
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'B', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'user', content: 'A', timestamp: '2024-01-01T00:00:00Z' }
      ]);
      cache.addMessages('session-2', 'tmux-1', '/test/cwd', [
        { type: 'assistant', content: 'C', timestamp: '2024-01-01T00:00:02Z' },
        { type: 'user', content: 'A', timestamp: '2024-01-01T00:00:00Z' } // Duplicate
      ]);

      const result = cache.getMessagesByTmux('tmux-1');

      expect(result).toHaveLength(3);
      expect(result.map(m => m.content)).toEqual(['A', 'B', 'C']);
    });

    it('should respect limit parameter', () => {
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'A', timestamp: '2024-01-01T00:00:00Z' },
        { type: 'user', content: 'B', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'user', content: 'C', timestamp: '2024-01-01T00:00:02Z' }
      ]);

      const result = cache.getMessagesByTmux('tmux-1', 2);

      expect(result).toHaveLength(2);
      expect(result.map(m => m.content)).toEqual(['B', 'C']);
    });
  });

  describe('getHealthInfo', () => {
    it('should return session health info', () => {
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ]);

      const health = cache.getHealthInfo();

      expect(health['session-1']).toBeDefined();
      expect(health['session-1'].messageCount).toBe(1);
      expect(health['session-1'].tmuxSession).toBe('tmux-1');
      expect(health['session-1'].lastEvent).toBeGreaterThan(0);
    });
  });

  describe('persistence', () => {
    it('should persist and restore sessions', () => {
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ]);
      cache.persist();

      // Create new cache and restore
      const cache2 = new ConversationCache(testPersistPath);
      cache2.start();

      const result = cache2.getMessages('session-1');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Hello');

      cache2.stop();
    });

    it('should persist only last 10 messages per session', () => {
      const messages: CachedMessage[] = Array.from({ length: 20 }, (_, i) => ({
        type: 'user' as const,
        content: `Message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`
      }));

      cache.addMessages('session-1', 'tmux-1', '/test/cwd', messages);
      cache.persist();

      // Create new cache and restore
      const cache2 = new ConversationCache(testPersistPath);
      cache2.start();

      const result = cache2.getMessages('session-1');
      expect(result).toHaveLength(10);
      expect(result[0].content).toBe('Message 10');

      cache2.stop();
    });

    it('should not persist sessions with invalid sessionIds', () => {
      // Manually set an invalid session to simulate old data
      cache.addMessages('valid-session', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'Valid', timestamp: '2024-01-01T00:00:00Z' }
      ]);
      cache.persist();

      const cache2 = new ConversationCache(testPersistPath);
      cache2.start();

      expect(cache2.getMessages('valid-session')).toHaveLength(1);
      expect(cache2.getMessages('undefined')).toHaveLength(0);

      cache2.stop();
    });
  });

  describe('clearSession', () => {
    it('should remove a session completely', () => {
      cache.addMessages('session-1', 'tmux-1', '/test/cwd', [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' }
      ]);

      cache.clearSession('session-1');

      expect(cache.getMessages('session-1')).toHaveLength(0);
      expect(cache.getHealthInfo()['session-1']).toBeUndefined();
    });
  });

  describe('cleanup on persist', () => {
    it('should limit total sessions to maxSessions (50) on persist', () => {
      // Add 60 sessions
      for (let i = 0; i < 60; i++) {
        cache.addMessages(`session-${i}`, `tmux-${i}`, '/test/cwd', [
          { type: 'user', content: `Message ${i}`, timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z` }
        ]);
      }

      // Persist triggers cleanup
      cache.persist();

      // Check health info - should have max 50 sessions
      const health = cache.getHealthInfo();
      const sessionCount = Object.keys(health).length;
      expect(sessionCount).toBeLessThanOrEqual(50);

      // The oldest sessions should be removed (session-0 through session-9)
      expect(health['session-0']).toBeUndefined();
      // The most recent sessions should remain
      expect(health['session-59']).toBeDefined();
    });
  });
});
