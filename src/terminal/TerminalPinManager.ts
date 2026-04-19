// TerminalPinManager - lifecycle for read-only terminal pins on the portolan map.
//
// See [[constitution-terminals-in-map]]. Bridges the server's tmux control-mode
// fan-out (see TerminalStreamManager + `terminal:*` WebSocket messages) to
// wterm instances mounted inside DomPinLayer terminal-kind pins. One manager
// instance owns the shared WebSocket routing; each pin registers a handler
// keyed by sessionId and receives scrollback + live bytes.
//
// Input suppression: wterm is instantiated with a no-op `onData`, and its
// click-focus listener is removed after init so clicking the terminal does
// not steal keyboard focus from the rest of the page. Selection still works
// natively (DOM-per-row rendering). Kitty remains the sole typing surface.

import { WTerm } from '@wterm/dom'

export interface MountOptions {
  /** Worker session id (Session.id), the same key used by the server's
   *  `terminal:attach` handler. */
  sessionId: string
  /** DOM node that wterm takes over. Expected to be empty. */
  container: HTMLElement
  /** Optional hook called once we learn the tmux pane's actual column/row
   *  count (from the first `terminal:scrollback` frame). The caller passes
   *  the CSS width/height that would make wterm's autoResize pick exactly
   *  cols × rows *right now*; the layer back-computes intrinsic from zoom so
   *  the ask is zoom-invariant. Scrollback bytes laid out for the pane then
   *  render without mid-word wrap. The layer decides whether to apply the
   *  request — a user-resized pin keeps its size. */
  setIntrinsicSize?: (cssWidth: number, cssHeight: number) => void
}

export interface MountHandle {
  /** Tear down the wterm + unsubscribe from the server. Safe to call twice.
   *  Matches DomPinLayer's `VellumSurfaceMount.unmount` contract so the layer
   *  can treat this mount uniformly with vellum mounts. */
  unmount(): void
  /** Optional reflow hint, matching `VellumSurfaceMount.resize`. wterm's own
   *  ResizeObserver drives cell layout from the container's CSS size, so
   *  this is currently a no-op — the container CSS change is enough. */
  resize?(width: number): void
}

interface InternalMountHandle extends MountHandle {
  write(bytes: Uint8Array): void
  ready: Promise<void>
}

interface Subscription {
  sessionId: string
  handle: InternalMountHandle
  term: WTerm
  disposed: boolean
  /** Bytes that arrived before wterm finished initialising. Replayed in order
   *  once `init()` resolves. Without this, the initial scrollback payload gets
   *  dropped because `term.write()` is a no-op before the WASM bridge exists. */
  pendingBytes: Uint8Array[]
  /** Pane size that arrived with the scrollback before wterm finished init.
   *  Applied before `pendingBytes` replay so the VT parser lays out at the
   *  right width. See [[wterm-col-width-mismatch]]. */
  pendingResize: { cols: number; rows: number } | null
  attached: boolean
  /** Optional "please set pin size to N px × M px" hook, honoured once. Calling
   *  twice in a session is harmless — the layer itself becomes a no-op after
   *  the pin diverges from its default — but we skip the redundant trip. */
  setIntrinsicSize: ((width: number, height: number) => void) | null
  autoSized: boolean
}

interface TerminalAttachMessage {
  type: 'terminal:attach'
  sessionId: string
}
interface TerminalDetachMessage {
  type: 'terminal:detach'
  sessionId: string
}
interface TerminalScrollbackMessage {
  type: 'terminal:scrollback'
  sessionId: string
  bytes: string
  /** Current tmux pane column width — sent so we can resize wterm to match
   *  the rendering Claude Code actually produced, avoiding mid-word wrap.
   *  See [[wterm-col-width-mismatch]]. */
  cols?: number
  rows?: number
}
interface TerminalBytesMessage {
  type: 'terminal:bytes'
  sessionId: string
  bytes: string
}
interface TerminalExitMessage {
  type: 'terminal:exit'
  sessionId: string
  reason?: string
}
interface TerminalErrorMessage {
  type: 'terminal:error'
  sessionId: string
  error: string
}

type IncomingTerminalMessage =
  | TerminalScrollbackMessage
  | TerminalBytesMessage
  | TerminalExitMessage
  | TerminalErrorMessage

export class TerminalPinManager {
  private ws: WebSocket | null = null
  private readonly subscriptions = new Map<string, Subscription>()

  /** Hand the shared state-sync WebSocket to the manager. On reconnect, the
   *  new socket is re-plumbed and every live pin re-sends `terminal:attach`
   *  so bytes resume flowing. Safe to call with the same socket twice. */
  setWebSocket(ws: WebSocket): void {
    if (this.ws === ws) return
    this.ws = ws
    // Re-attach anything that was already mounted when the previous socket
    // dropped. Scrollback will come back fresh (server replays on attach), so
    // we clear the prior rendered state first to avoid doubled history.
    for (const sub of this.subscriptions.values()) {
      if (sub.disposed) continue
      this.sendAttach(sub.sessionId)
      sub.attached = true
    }
  }

  /** Called by FrontendStateSync's handlePanelMessage fork. Returns true when
   *  the message was a `terminal:*` event (so the host stops routing). */
  handleMessage(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false
    const m = message as { type?: string }
    if (typeof m.type !== 'string' || !m.type.startsWith('terminal:')) return false
    const typed = m as IncomingTerminalMessage
    const sub = this.subscriptions.get(typed.sessionId)
    if (!sub || sub.disposed) return true
    switch (typed.type) {
      case 'terminal:scrollback': {
        // Resize wterm to the actual pane size *before* writing bytes so the
        // VT parser lays out Claude Code's columns at the right width. If the
        // container is narrower than that, wterm's autoResize will immediately
        // shrink cols to fit — so we also ask the layer to grow the pin to
        // pane-matching CSS dimensions (honoured only while the pin is still
        // at its kind default — user resize wins). Without this, bytes laid
        // out at 102 cols wrap mid-word at ~73 cols, the staircase regression.
        if (typed.cols && typed.rows) {
          if (sub.term.bridge) sub.term.resize(typed.cols, typed.rows)
          else sub.pendingResize = { cols: typed.cols, rows: typed.rows }
          if (!sub.autoSized && sub.setIntrinsicSize) {
            sub.autoSized = true
            const { width, height } = pinSizeForPane(typed.cols, typed.rows)
            sub.setIntrinsicSize(width, height)
          }
        }
        const bytes = decodeBase64(typed.bytes)
        if (sub.term.bridge) sub.term.write(bytes)
        else sub.pendingBytes.push(bytes)
        break
      }
      case 'terminal:bytes': {
        const bytes = decodeBase64(typed.bytes)
        if (sub.term.bridge) sub.term.write(bytes)
        else sub.pendingBytes.push(bytes)
        break
      }
      case 'terminal:exit':
        // tmux pane has exited server-side. Render a muted banner so the user
        // sees why the stream froze; unsubscribe so repeated exits don't
        // stack. Keep the wterm mounted so the last-seen state stays visible.
        writeMutedLine(sub.term, `[session ${typed.sessionId} exited${typed.reason ? ': ' + typed.reason : ''}]`)
        sub.attached = false
        break
      case 'terminal:error':
        writeMutedLine(sub.term, `[terminal error: ${typed.error}]`)
        break
    }
    return true
  }

  /** Mount a wterm into `container` and subscribe to the worker's tmux pane.
   *  Returns a handle the pin layer can `dispose()` on unmount. */
  mount(opts: MountOptions): MountHandle {
    const existing = this.subscriptions.get(opts.sessionId)
    if (existing && !existing.disposed) {
      // A second card for the same session: tear down the old mount so there
      // is exactly one wterm per sessionId in the active tab. Server refcount
      // tolerates two subscribers via the same WS but we don't need it here.
      existing.handle.unmount()
    }

    const term = new WTerm(opts.container, {
      cols: 80,
      rows: 24,
      autoResize: true,
      // onData fires when wterm's internal InputHandler encodes a keystroke
      // into a PTY byte sequence. In portolan's read-only view we swallow it
      // entirely — Kitty stays the sole typing surface. See constitution
      // non-goals: "No typing in portolan terminals."
      onData: () => {},
    })

    const sub: Subscription = {
      sessionId: opts.sessionId,
      handle: null as unknown as InternalMountHandle,
      term,
      disposed: false,
      pendingBytes: [],
      pendingResize: null,
      attached: false,
      setIntrinsicSize: opts.setIntrinsicSize ?? null,
      autoSized: false,
    }
    this.subscriptions.set(opts.sessionId, sub)

    const ready = term.init().then(() => {
      if (sub.disposed) return
      // Remove wterm's "click focuses the terminal textarea" listener. Without
      // this, clicking the in-map terminal steals focus from the map surface
      // and starts eating keyboard chords. We already no-op onData, so focus
      // would be a wasted side effect anyway.
      const onClickFocus = (term as unknown as { _onClickFocus?: () => void })._onClickFocus
      if (onClickFocus) {
        term.element.removeEventListener('click', onClickFocus)
      }
      // Apply the queued pane size first so the VT parser knows the column
      // count *before* replaying scrollback. Then drain the byte queue.
      if (sub.pendingResize) {
        term.resize(sub.pendingResize.cols, sub.pendingResize.rows)
        sub.pendingResize = null
      }
      for (const chunk of sub.pendingBytes) term.write(chunk)
      sub.pendingBytes = []
    }).catch((err) => {
      console.error('[TerminalPinManager] wterm init failed', err)
    })

    // Subscribe eagerly — the server sends scrollback first, then live bytes.
    // If the socket isn't open yet, setWebSocket() will resubscribe on connect.
    this.sendAttach(opts.sessionId)
    sub.attached = true

    const handle: InternalMountHandle = {
      write(bytes) {
        if (sub.disposed) return
        if (sub.term.bridge) sub.term.write(bytes)
        else sub.pendingBytes.push(bytes)
      },
      unmount: () => {
        if (sub.disposed) return
        sub.disposed = true
        if (sub.attached) this.sendDetach(opts.sessionId)
        sub.attached = false
        try { term.destroy() } catch (err) {
          console.warn('[TerminalPinManager] wterm destroy threw', err)
        }
        // Only drop the map entry if we're still the current subscription;
        // a re-mount above may have already replaced us.
        if (this.subscriptions.get(opts.sessionId) === sub) {
          this.subscriptions.delete(opts.sessionId)
        }
      },
      ready,
    }
    sub.handle = handle
    return handle
  }

  /** Current subscribers — testing / diagnostics. */
  activeSessionIds(): string[] {
    return [...this.subscriptions.keys()].filter((id) => !this.subscriptions.get(id)!.disposed)
  }

  private sendAttach(sessionId: string): void {
    this.send<TerminalAttachMessage>({ type: 'terminal:attach', sessionId })
  }

  private sendDetach(sessionId: string): void {
    this.send<TerminalDetachMessage>({ type: 'terminal:detach', sessionId })
  }

  private send<T>(message: T): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(message))
  }
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Write a single dim status line to the terminal with a trailing newline so
 *  the next incoming bytes start on a fresh row. Used for session-exit /
 *  error banners from the server. */
function writeMutedLine(term: WTerm, text: string): void {
  const seq = `\r\n\x1b[2m${text}\x1b[0m\r\n`
  if (term.bridge) term.write(seq)
}

/** wterm renders at Menlo 14px (see `@wterm/dom/src/terminal.css`). A "W"
 *  cell measures ~8.4px wide; rows are a fixed 17px (`--term-row-height`).
 *  wterm wraps its grid in a 12px padding; the pin's chrome strip adds ~23px.
 *  We add 2px for the shell's 1px border. These are the constants wterm's
 *  autoResize uses under the hood, mirrored here so we can ask for a pin size
 *  that makes autoResize pick exactly `cols × rows` without a second settle. */
const WTERM_CELL_WIDTH = 8.4
const WTERM_CELL_HEIGHT = 17
const WTERM_PADDING = 12
const PIN_CHROME_HEIGHT = 23
const PIN_BORDER = 2

export function pinSizeForPane(cols: number, rows: number): { width: number; height: number } {
  const width = Math.ceil(cols * WTERM_CELL_WIDTH + WTERM_PADDING * 2 + PIN_BORDER)
  const height = Math.ceil(rows * WTERM_CELL_HEIGHT + WTERM_PADDING * 2 + PIN_CHROME_HEIGHT + PIN_BORDER)
  return { width, height }
}
