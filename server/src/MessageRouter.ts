/**
 * MessageRouter - WebSocket message dispatch
 *
 * Routes incoming WebSocket messages to appropriate handlers.
 * Separates the "what type of message is this" logic from
 * the actual message handling.
 */

import { WebSocket } from 'ws';
import type { BrowserAttentionState } from './BrowserStateCoordinator.js';
import type { GitStatus } from './GitStatusManager.js';

// ============================================================================
// Message Types
// ============================================================================

export interface FocusMessage {
  type: 'focus';
  sessionId: string;
}

/** Focus or launch a kitty tab attached to a tmux session named directly,
 *  rather than via a portolan session id. Used by the kanban modal right
 *  after a Shuttle dispatch — the new tmux session exists but portolan's
 *  SessionTracker hasn't polled it yet, so a `focus` keyed on portolan
 *  session id would silently no-op. Pairs with the shuttle daemon's
 *  wait-for-client gate in the run-script: the daemon waits for an
 *  interactive client; this is what attaches it. */
export interface FocusByTmuxNameMessage {
  type: 'focusByTmuxName';
  tmuxSession: string;
}

export interface AgentSessionsUpdateMessage {
  type: 'agent_sessions_update';
  payload: {
    sessions: Array<{
      id?: string;
      name: string;
      tmuxSession: string;
      cwd: string;
      status?: 'idle' | 'working' | 'offline';
      hasClaims?: boolean;
      hasPlaygrounds?: boolean;
      gitStatus?: GitStatus;
    }>;
  };
}

export interface AgentActivityMessage {
  type: 'agent_activity';
  activity: {
    tmuxSession: string;
    tool: string;
    summary?: string;
    fullPath?: string;                     // Full file path for Read/Write/Edit
    timestamp: number;
  };
}

export interface GetFibersMessage {
  type: 'getFibers';
  cityId: string;
}

export interface HandoffMessage {
  type: 'handoff';
  fiberId: string;
  cityPath: string;
}

export interface NewWorkerMessage {
  type: 'newWorker';
  cityPath: string;
  name?: string;
  chrome?: boolean;
  continue?: boolean;
  cli?: string;
}

export interface PinCityMessage {
  type: 'pinCity';
  path: string;
  position: { q: number; r: number };
  name?: string;
}

export interface UnpinCityMessage {
  type: 'unpinCity';
  cityId: string;
}

export interface ConfirmUnpinMessage {
  type: 'confirmUnpinCity';
  cityId: string;
}

export interface KillWorkerMessage {
  type: 'killWorker';
  sessionId: string;
}

export interface SearchFilesMessage {
  type: 'searchFiles';
  cityId: string;
  query: string;
  searchId: string;  // For cancellation
  mode?: 'filename' | 'content';  // Default: filename
}

export interface MoveCityMessage {
  type: 'moveCity';
  cityId: string;
  newPosition: { q: number; r: number };
}

export interface ListDirectoryMessage {
  type: 'listDirectory';
  cityId: string;
  path: string;
}

export interface BrowserAttentionMessage {
  type: 'browserAttention';
  attention: BrowserAttentionState;
}

/** Subscribe to a worker's live tmux pane output. Server responds with a
 *  one-shot `terminal:scrollback` (current buffer) then a stream of
 *  `terminal:bytes` chunks until the client sends `terminal:detach` or the
 *  socket closes. See constitution-terminals-in-map. */
export interface TerminalAttachMessage {
  type: 'terminal:attach';
  /** tmux session name — the `tmuxSession` field from a `Session`. This is
   *  the multiplex key: two clients subscribing to the same session share
   *  one tmux control-mode client. */
  sessionId: string;
}

export interface TerminalDetachMessage {
  type: 'terminal:detach';
  sessionId: string;
}

export type ClientMessage =
  | FocusMessage
  | FocusByTmuxNameMessage
  | AgentSessionsUpdateMessage
  | GetFibersMessage
  | HandoffMessage
  | NewWorkerMessage
  | PinCityMessage
  | UnpinCityMessage
  | ConfirmUnpinMessage
  | KillWorkerMessage
  | SearchFilesMessage
  | MoveCityMessage
  | ListDirectoryMessage
  | BrowserAttentionMessage
  | TerminalAttachMessage
  | TerminalDetachMessage;

// ============================================================================
// Handler Interface
// ============================================================================

export interface MessageHandlers {
  onFocus(sessionId: string): void;
  onFocusByTmuxName(tmuxSession: string): void;
  onGetFibers(ws: WebSocket, cityId: string): Promise<void>;
  onHandoff(fiberId: string, cityPath: string): void | Promise<void>;
  onNewWorker(ws: WebSocket, cityPath: string, name?: string, chrome?: boolean, continueSession?: boolean, cli?: string): void;
  onPinCity(ws: WebSocket, path: string, position: { q: number; r: number }, name?: string): void;
  onUnpinCity(ws: WebSocket, cityId: string): void;
  onConfirmUnpin(ws: WebSocket, cityId: string): void;
  onKillWorker(sessionId: string): void;
  onSearchFiles(ws: WebSocket, cityId: string, query: string, searchId: string, mode?: 'filename' | 'content'): void;
  onMoveCity(ws: WebSocket, cityId: string, newPosition: { q: number; r: number }): void;
  onListDirectory(ws: WebSocket, cityId: string, path: string): void;
  onBrowserAttention(ws: WebSocket, attention: BrowserAttentionState): void;
  onTerminalAttach(ws: WebSocket, sessionId: string): void;
  onTerminalDetach(ws: WebSocket, sessionId: string): void;
}

// ============================================================================
// MessageRouter
// ============================================================================

export class MessageRouter {
  private handlers: MessageHandlers;

  constructor(handlers: MessageHandlers) {
    this.handlers = handlers;
  }

  /**
   * Route a message from a browser client to the appropriate handler
   */
  routeClientMessage(ws: WebSocket, data: string): void {
    try {
      const message = JSON.parse(data) as ClientMessage;
      console.log('[MessageRouter] Received:', message.type);

      switch (message.type) {
        case 'focus':
          this.handlers.onFocus(message.sessionId);
          break;

        case 'focusByTmuxName':
          this.handlers.onFocusByTmuxName(message.tmuxSession);
          break;

        case 'getFibers':
          this.handlers.onGetFibers(ws, message.cityId);
          break;

        case 'handoff':
          this.handlers.onHandoff(message.fiberId, message.cityPath);
          break;

        case 'newWorker':
          this.handlers.onNewWorker(ws, message.cityPath, message.name, message.chrome, message.continue, message.cli);
          break;

        case 'pinCity':
          this.handlers.onPinCity(ws, message.path, message.position, message.name);
          break;

        case 'unpinCity':
          this.handlers.onUnpinCity(ws, message.cityId);
          break;

        case 'confirmUnpinCity':
          this.handlers.onConfirmUnpin(ws, message.cityId);
          break;

        case 'killWorker':
          this.handlers.onKillWorker(message.sessionId);
          break;

        case 'searchFiles':
          this.handlers.onSearchFiles(ws, message.cityId, message.query, message.searchId, message.mode);
          break;

        case 'moveCity':
          this.handlers.onMoveCity(ws, message.cityId, message.newPosition);
          break;

        case 'listDirectory':
          this.handlers.onListDirectory(ws, message.cityId, message.path);
          break;

        case 'browserAttention':
          this.handlers.onBrowserAttention(ws, message.attention);
          break;

        case 'terminal:attach':
          this.handlers.onTerminalAttach(ws, message.sessionId);
          break;

        case 'terminal:detach':
          this.handlers.onTerminalDetach(ws, message.sessionId);
          break;

        default:
          console.warn('[MessageRouter] Unknown message type:', (message as any).type);
      }
    } catch (error) {
      console.error('[MessageRouter] Failed to handle message:', error);
    }
  }
}
