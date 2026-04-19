/**
 * TmuxControlClient - thin wrapper around `tmux -CC attach -r -t <session>`.
 *
 * Control mode is the protocol iTerm2 uses to render tmux panes natively:
 * structured line-oriented output where each line begins with `%<event>`.
 * We only care about `%output %<pane-id> <escaped-bytes>` (pane data) and
 * `%exit` (tmux closed). Everything else is logged and dropped.
 *
 * Byte escape format (from tmux/control.c control_write_output): bytes
 * outside printable ASCII (<0x20, backslash, >0x7e) are emitted as three
 * octal digits preceded by `\`. Printable ASCII passes through raw. There
 * is no `\\` escape — backslash itself comes back as `\134`.
 *
 * See constitution `constitution-terminals-in-map` (Bridge layer).
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export interface TmuxControlClientOptions {
  tmuxSession: string;
  /** Width/height to declare via `refresh-client -C`. Keeping this large
   *  prevents our read-only attach from shrinking Kitty's pane on sessions
   *  with `window-size latest` (tmux's default multi-client mode). */
  declaredSize?: { width: number; height: number };
  /** Override the child process factory for testing (default: real spawn). */
  spawnFn?: typeof spawn;
}

export interface TmuxControlClientCallbacks {
  onBytes?: (bytes: Buffer) => void;
  onExit?: (reason?: string) => void;
  onError?: (err: string) => void;
}

export class TmuxControlClient {
  private readonly tmuxSession: string;
  private readonly declaredSize: { width: number; height: number };
  private readonly spawnFn: typeof spawn;
  private readonly callbacks: TmuxControlClientCallbacks;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineBuf = '';
  private stopped = false;

  constructor(opts: TmuxControlClientOptions, callbacks: TmuxControlClientCallbacks) {
    this.tmuxSession = opts.tmuxSession;
    this.declaredSize = opts.declaredSize ?? { width: 200, height: 50 };
    this.spawnFn = opts.spawnFn ?? spawn;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.child) return;
    // tmux matches `-t` as exact-or-prefix; `=name:` forces exact. We pass
    // it raw to spawn (argv) so no shell escaping — that's a shell-only
    // concern (see gotcha-ssh-double-quote family).
    const target = `=${this.tmuxSession}:`;
    // `-C` enables control mode, `-r` makes the attach read-only. Double
    // `-CC` also works; single `-C` is sufficient for a non-interactive
    // pipe-based client (we never write to stdin after the initial
    // refresh-client command).
    this.child = this.spawnFn('tmux', ['-C', 'attach', '-r', '-t', target], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.callbacks.onError?.(chunk.trimEnd());
    });
    this.child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.child = null;
      if (!this.stopped) this.callbacks.onExit?.(reason);
    });
    this.child.on('error', (err) => {
      this.callbacks.onError?.(err.message);
    });
    // Declare a large window size so our read-only attach does not squeeze
    // the pane when tmux recalculates for the smallest client. Commands in
    // control mode go over stdin as plain tmux commands, newline-terminated.
    this.child.stdin.write(`refresh-client -C ${this.declaredSize.width}x${this.declaredSize.height}\n`);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch { /* ignore */ }
    // Graceful shutdown via SIGTERM; control-mode client detaches cleanly.
    child.kill('SIGTERM');
    this.child = null;
  }

  /** For testing — feed a chunk of control-mode output and drive parsing.
   *  Never call in production; real data flows via the stdout listener. */
  feedForTest(chunk: string): void {
    this.onStdout(chunk);
  }

  private onStdout(chunk: string): void {
    this.lineBuf += chunk;
    // Control mode is line-delimited (`\n`). A pane-output line carries
    // escaped bytes (incl. embedded newlines as `\012`) so splitting on a
    // raw `\n` is safe — no escape sequence spans lines.
    let idx: number;
    while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // Fast path: pane output. `%output %<id> <escaped>`. `<escaped>` may
    // contain spaces but `<id>` has none, so split on first two spaces.
    if (line.startsWith('%output ')) {
      const afterTag = line.slice(8);
      const sp = afterTag.indexOf(' ');
      if (sp < 0) return;
      // Skip pane-id segment entirely — we forward every pane of the session.
      const escaped = afterTag.slice(sp + 1);
      const bytes = decodeTmuxEscape(escaped);
      this.callbacks.onBytes?.(bytes);
      return;
    }
    if (line.startsWith('%exit')) {
      const reason = line.length > 5 ? line.slice(6) : undefined;
      this.callbacks.onExit?.(reason);
      return;
    }
    if (line.startsWith('%error')) {
      this.callbacks.onError?.(line.slice(7));
      return;
    }
    // Structural events (%begin/%end, %window-*, %session-changed, etc.)
    // carry no pane bytes; ignore for now. They are useful later for
    // detecting pane adds/removes when we support multi-pane sessions.
  }
}

/**
 * Decode the `\ddd` octal escapes tmux applies to pane bytes in control
 * mode. See the header comment for the escape rules. Returns a Buffer so
 * downstream can pass raw bytes to a wterm renderer without touching
 * UTF-8 at the boundary.
 */
export function decodeTmuxEscape(input: string): Buffer {
  // Over-allocate; worst case every 4 input chars (`\ddd`) decode to 1 byte,
  // best case 1 input char → 1 byte. Source uses UTF-16 units and we emit
  // a byte per printable ASCII, so input length is a safe upper bound on
  // byte length in practice (multi-byte scalars are escaped).
  const out = Buffer.alloc(input.length);
  let w = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x5c && i + 3 < input.length) {
      const a = input.charCodeAt(i + 1);
      const b = input.charCodeAt(i + 2);
      const d = input.charCodeAt(i + 3);
      if (isOctal(a) && isOctal(b) && isOctal(d)) {
        out[w++] = ((a - 0x30) << 6) | ((b - 0x30) << 3) | (d - 0x30);
        i += 3;
        continue;
      }
    }
    // Printable ASCII falls through as-is. If we ever see a malformed
    // escape (bare `\` without 3 octal digits) pass it through too — better
    // to render a stray backslash than drop bytes.
    out[w++] = c & 0xff;
  }
  return out.subarray(0, w);
}

function isOctal(code: number): boolean {
  return code >= 0x30 && code <= 0x37;
}
