/**
 * ConversationCache - In-memory conversation cache with disk persistence
 *
 * Receives conversation updates via hooks (not polling).
 * Stores messages in memory, persists to disk every 30s + on shutdown.
 *
 * Architecture:
 *   Hook fires → POST /hook/message → ConversationCache.addMessages()
 *                                   → WebSocket broadcast → UI
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export interface CachedMessage {
  type: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: string;
  // For tool_use
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  // For thinking
  preview?: string;
  // For system messages
  systemType?: 'skill' | 'reminder';
}

interface SessionCache {
  messages: CachedMessage[];
  tmuxSession: string;
  cwd: string;
  lastUpdate: number;
}

interface PersistedData {
  version: 1;
  sessions: Record<string, SessionCache>;
}

type MessageCallback = (sessionId: string, tmuxSession: string, messages: CachedMessage[]) => void;

export class ConversationCache {
  private sessions: Map<string, SessionCache> = new Map();
  private persistPath: string;
  private persistInterval: ReturnType<typeof setInterval> | null = null;
  private maxMessagesPerSession = 100;  // Keep last 100 messages per session
  private maxSessions = 50;  // Cap total sessions to prevent unbounded growth
  private sessionMaxAge = 7 * 24 * 60 * 60 * 1000;  // 7 days in ms
  private messageCallback: MessageCallback | null = null;
  private lastEventBySession: Map<string, number> = new Map();

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? join(homedir(), '.portolan', 'conversations.json');
  }

  /**
   * Set callback for new messages (used to broadcast via WebSocket)
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Start persistence timer
   */
  start(): void {
    // Restore from disk
    this.restore();

    // Persist every 30 seconds
    this.persistInterval = setInterval(() => {
      this.persist();
    }, 30_000);

    console.log(`[ConversationCache] Started (${this.sessions.size} sessions restored)`);
  }

  /**
   * Stop and persist
   */
  stop(): void {
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
    }
    this.persist();
    console.log('[ConversationCache] Stopped');
  }

  /**
   * Add messages from a hook event
   */
  addMessages(
    sessionId: string,
    tmuxSession: string,
    cwd: string,
    messages: CachedMessage[]
  ): void {
    if (messages.length === 0) return;

    let cache = this.sessions.get(sessionId);
    if (!cache) {
      cache = {
        messages: [],
        tmuxSession,
        cwd,
        lastUpdate: Date.now(),
      };
      this.sessions.set(sessionId, cache);
    }

    // Update metadata
    cache.tmuxSession = tmuxSession;
    cache.cwd = cwd;
    cache.lastUpdate = Date.now();

    // Deduplicate: skip messages with timestamps we've already seen
    const existingTimestamps = new Set(cache.messages.map(m => m.timestamp));
    const newMessages = messages.filter(m => !existingTimestamps.has(m.timestamp));

    if (newMessages.length === 0) return;

    // Add new messages
    cache.messages.push(...newMessages);

    // Trim to max
    if (cache.messages.length > this.maxMessagesPerSession) {
      cache.messages = cache.messages.slice(-this.maxMessagesPerSession);
    }

    // Update last event time
    this.lastEventBySession.set(sessionId, Date.now());

    // Notify callback
    if (this.messageCallback) {
      this.messageCallback(sessionId, tmuxSession, newMessages);
    }

    console.log(`[ConversationCache] ${sessionId}: +${newMessages.length} messages (${cache.messages.length} total)`);
  }

  /**
   * Get messages for a session
   */
  getMessages(sessionId: string, limit?: number): CachedMessage[] {
    const cache = this.sessions.get(sessionId);
    if (!cache) return [];

    const messages = cache.messages;
    return limit ? messages.slice(-limit) : messages;
  }

  /**
   * Get messages for a session by tmux session name (fallback for lookup)
   * Aggregates messages from ALL Claude sessions in this tmux session
   */
  getMessagesByTmux(tmuxSession: string, limit?: number): CachedMessage[] {
    // Collect messages from all sessions with this tmux session
    const allMessages: CachedMessage[] = [];
    for (const cache of this.sessions.values()) {
      if (cache.tmuxSession === tmuxSession) {
        allMessages.push(...cache.messages);
      }
    }

    if (allMessages.length === 0) return [];

    // Sort and deduplicate by timestamp
    allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const deduped = this.deduplicateByTimestamp(allMessages);

    return limit ? deduped.slice(-limit) : deduped;
  }

  /**
   * Remove duplicate messages by timestamp
   */
  private deduplicateByTimestamp(messages: CachedMessage[]): CachedMessage[] {
    const seen = new Set<string>();
    return messages.filter(m => {
      if (seen.has(m.timestamp)) return false;
      seen.add(m.timestamp);
      return true;
    });
  }

  /**
   * Get session ID by tmux session name
   */
  findSessionByTmux(tmuxSession: string): string | undefined {
    for (const [sessionId, cache] of this.sessions) {
      if (cache.tmuxSession === tmuxSession) {
        return sessionId;
      }
    }
    return undefined;
  }

  /**
   * Get last event time for a session (for /hook/health)
   */
  getLastEventTime(sessionId: string): number | undefined {
    return this.lastEventBySession.get(sessionId);
  }

  /**
   * Get all session IDs with their last event times (for /hook/health)
   */
  getHealthInfo(): Record<string, { lastEvent: number; messageCount: number; tmuxSession: string }> {
    const info: Record<string, { lastEvent: number; messageCount: number; tmuxSession: string }> = {};
    for (const [sessionId, cache] of this.sessions) {
      info[sessionId] = {
        lastEvent: this.lastEventBySession.get(sessionId) ?? cache.lastUpdate,
        messageCount: cache.messages.length,
        tmuxSession: cache.tmuxSession,
      };
    }
    return info;
  }

  /**
   * Clean up old/excess sessions to prevent unbounded memory growth
   */
  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    // Find sessions older than max age
    for (const [sessionId, cache] of this.sessions) {
      if (now - cache.lastUpdate > this.sessionMaxAge) {
        toDelete.push(sessionId);
      }
    }

    // Delete old sessions
    for (const sessionId of toDelete) {
      this.sessions.delete(sessionId);
      this.lastEventBySession.delete(sessionId);
    }

    // If still over limit, remove oldest sessions
    if (this.sessions.size > this.maxSessions) {
      const sorted = [...this.sessions.entries()]
        .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);

      const excess = this.sessions.size - this.maxSessions;
      for (let i = 0; i < excess; i++) {
        const [sessionId] = sorted[i];
        this.sessions.delete(sessionId);
        this.lastEventBySession.delete(sessionId);
      }
    }

    if (toDelete.length > 0 || this.sessions.size > this.maxSessions) {
      console.log(`[ConversationCache] Cleanup: removed ${toDelete.length} old sessions, ${this.sessions.size} remain`);
    }
  }

  /**
   * Persist to disk
   */
  persist(): void {
    // Clean up before persisting
    this.cleanup();

    const dir = dirname(this.persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data: PersistedData = {
      version: 1,
      sessions: {},
    };

    // Only persist sessions with messages
    for (const [sessionId, cache] of this.sessions) {
      if (cache.messages.length > 0) {
        // Keep only last 10 messages per session in persistence (lighter footprint)
        data.sessions[sessionId] = {
          ...cache,
          messages: cache.messages.slice(-10),
        };
      }
    }

    const tmpPath = this.persistPath + '.tmp';
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      renameSync(tmpPath, this.persistPath);
    } catch (error) {
      console.error('[ConversationCache] Failed to persist:', error);
    }
  }

  /**
   * Restore from disk
   */
  restore(): void {
    if (!existsSync(this.persistPath)) return;

    try {
      const content = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(content) as PersistedData;

      if (data.version !== 1) return;

      for (const [sessionId, cache] of Object.entries(data.sessions)) {
        this.sessions.set(sessionId, cache);
        this.lastEventBySession.set(sessionId, cache.lastUpdate);
      }
    } catch (error) {
      console.error('[ConversationCache] Failed to restore:', error);
    }
  }

  /**
   * Clear cache for a session (e.g., when session ends)
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastEventBySession.delete(sessionId);
  }
}
