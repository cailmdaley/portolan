/**
 * TerminalStreamManager - multiplexed, refcounted fan-out of tmux pane
 * bytes to WebSocket subscribers.
 *
 * For each tmux session that has at least one subscriber we keep a single
 * `tmux -CC attach -r` process (a `TmuxControlClient`). Every subscriber
 * gets the same bytes the client emits. When the last subscriber for a
 * session detaches, we tear the client down. A subscriber may attach to
 * multiple sessions; the same WS may also attach to the same session
 * twice (e.g. two cards open on different monitors) — the refcount
 * tolerates that.
 *
 * Scrollback is a separate concern. `getScrollback()` captures the pane's
 * current buffer via `tmux capture-pane -pe -S -N`; the manager hands
 * that back synchronously on demand, then starts streaming live bytes.
 *
 * Local-only for this iteration (constitution scope: "Local-only in this
 * loop"). Remote support will plug the same subscribe/fan-out interface
 * into the portolan-agent tailer on the remote side.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { TmuxControlClient, type TmuxControlClientCallbacks, type TmuxControlClientOptions } from './TmuxControlClient.js';

const execFileAsync = promisify(execFile);

export type TerminalSubscriber = {
  /** Opaque id — usually the WebSocket instance itself. Used to dedupe
   *  subscribers so double-attach from the same client is refcounted. */
  key: object;
  onBytes: (bytes: Buffer) => void;
  onExit?: (reason?: string) => void;
  onError?: (err: string) => void;
};

export interface TerminalStreamManagerOptions {
  /** Inject a factory for testing (default: real TmuxControlClient). */
  createClient?: (opts: TmuxControlClientOptions, cb: TmuxControlClientCallbacks) => TmuxControlClient;
  /** Inject scrollback capture for testing (default: `tmux capture-pane`). */
  captureScrollback?: (tmuxSession: string, lines: number) => Promise<Buffer>;
  /** Lines of history to replay on attach. Constitution: 5k. */
  scrollbackLines?: number;
}

interface SessionEntry {
  client: TmuxControlClient;
  subscribers: Map<object, TerminalSubscriber>;
}

export class TerminalStreamManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly createClient: NonNullable<TerminalStreamManagerOptions['createClient']>;
  private readonly captureScrollback: NonNullable<TerminalStreamManagerOptions['captureScrollback']>;
  private readonly scrollbackLines: number;

  constructor(opts: TerminalStreamManagerOptions = {}) {
    this.createClient = opts.createClient ?? ((o, cb) => new TmuxControlClient(o, cb));
    this.captureScrollback = opts.captureScrollback ?? defaultCaptureScrollback;
    this.scrollbackLines = opts.scrollbackLines ?? 5000;
  }

  /** Subscribe to a tmux session's pane bytes. Spawns the backing tmux
   *  control client on first subscriber; idempotent for the same key
   *  (double-attach refcounts as one). */
  attach(tmuxSession: string, subscriber: TerminalSubscriber): void {
    let entry = this.sessions.get(tmuxSession);
    if (!entry) {
      const client = this.createClient(
        { tmuxSession },
        {
          onBytes: (bytes) => this.fanoutBytes(tmuxSession, bytes),
          onExit: (reason) => this.fanoutExit(tmuxSession, reason),
          onError: (err) => this.fanoutError(tmuxSession, err),
        },
      );
      entry = { client, subscribers: new Map() };
      this.sessions.set(tmuxSession, entry);
      client.start();
    }
    entry.subscribers.set(subscriber.key, subscriber);
  }

  /** Unsubscribe one subscriber. If the session has no remaining
   *  subscribers, the backing tmux client is torn down. */
  detach(tmuxSession: string, key: object): void {
    const entry = this.sessions.get(tmuxSession);
    if (!entry) return;
    entry.subscribers.delete(key);
    if (entry.subscribers.size === 0) {
      entry.client.stop();
      this.sessions.delete(tmuxSession);
    }
  }

  /** Remove a subscriber from every session it's attached to. Call on
   *  WebSocket close so a disconnecting client doesn't leak tmux clients. */
  detachAll(key: object): void {
    for (const [tmuxSession, entry] of [...this.sessions]) {
      if (entry.subscribers.has(key)) {
        this.detach(tmuxSession, key);
      }
    }
  }

  /** One-shot history replay for a pane. Used on attach so the browser
   *  sees the current boxed Claude UI without waiting for the next frame. */
  async getScrollback(tmuxSession: string): Promise<Buffer> {
    return this.captureScrollback(tmuxSession, this.scrollbackLines);
  }

  /** Test / diagnostic: active sessions and subscriber counts. */
  stats(): Array<{ tmuxSession: string; subscribers: number }> {
    return [...this.sessions.entries()].map(([tmuxSession, entry]) => ({
      tmuxSession,
      subscribers: entry.subscribers.size,
    }));
  }

  /** Tear down everything — for server shutdown and tests. */
  stop(): void {
    for (const entry of this.sessions.values()) entry.client.stop();
    this.sessions.clear();
  }

  private fanoutBytes(tmuxSession: string, bytes: Buffer): void {
    const entry = this.sessions.get(tmuxSession);
    if (!entry) return;
    for (const sub of entry.subscribers.values()) sub.onBytes(bytes);
  }

  private fanoutExit(tmuxSession: string, reason?: string): void {
    const entry = this.sessions.get(tmuxSession);
    if (!entry) return;
    for (const sub of entry.subscribers.values()) sub.onExit?.(reason);
    // tmux process exited — drop the entry so next attach respawns.
    this.sessions.delete(tmuxSession);
  }

  private fanoutError(tmuxSession: string, err: string): void {
    const entry = this.sessions.get(tmuxSession);
    if (!entry) return;
    for (const sub of entry.subscribers.values()) sub.onError?.(err);
  }
}

/** Default scrollback: `tmux capture-pane -pe -S -<N> -t =<session>:`.
 *  Returns the current pane buffer as bytes, escape sequences preserved
 *  (`-e`), from N lines back to the cursor (`-S -N`). */
async function defaultCaptureScrollback(tmuxSession: string, lines: number): Promise<Buffer> {
  const target = `=${tmuxSession}:`;
  // -p: write to stdout instead of a buffer
  // -e: include escape sequences for colors / attrs
  // -J: join wrapped lines (so copying a wrapped line gives one logical line)
  // -S -N: start N lines above the visible region (negative = from history)
  const { stdout } = await execFileAsync(
    'tmux',
    ['capture-pane', '-p', '-e', '-J', '-S', `-${lines}`, '-t', target],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}
