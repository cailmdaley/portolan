/**
 * DirectoryListingClient — promise-shaped wrapper around the WebSocket
 * `listDirectory` ↔ `directoryListing` round-trip used by `WorkspaceBrowser`.
 *
 * Stage E of constitution-portolan-navigation-layer added a *cross-project*
 * Files column to the Find dashboard; that column is a `react-arborist`
 * virtualized tree that lazy-loads each directory on expand. This client
 * exposes the WS protocol through a plain
 * `requestDirectoryListing(cityId, path) => Promise<...>` API the React
 * tree can `await`. (Stage I retired the legacy `CityHUDFileTree`
 * event-handler-shaped consumer of the same protocol.)
 *
 * Shape mirrors the protocol in `MessageRouter`:
 *
 *   client → { type: 'listDirectory', cityId, path }
 *   server → { type: 'directoryListing', cityId, path, entries[, error] }
 *
 * The server response carries no request id — so we key pending promises
 * by `${cityId}:${path}` and resolve every waiter for that key when the
 * matching `directoryListing` arrives. Two near-simultaneous requests for
 * the same (cityId, path) coalesce to one WS round-trip; that's a desirable
 * dedupe for the file tree (root expansion, racing toggles).
 *
 * Lives next to `FrontendStateSync` because it observes the same WS
 * messages; the wiring in `main.ts` plumbs each `directoryListing` through
 * `client.handleMessage` (the only consumer post-Stage-I).
 */

/** Directory entry shape returned by the server's `directoryListing`
 *  message. Lives here because this module is the only consumer post-Stage-I
 *  (formerly shared with `CityHUDFileTree` via `src/ui/hud-types.ts`). */
export interface DirectoryEntry {
  name: string
  type: 'file' | 'dir'
}

export interface DirectoryListingResult {
  entries: DirectoryEntry[]
  /** Server-reported error (`Path is outside city root`, `City not found`,
   *  permission errors, …). Empty when the listing succeeded. */
  error?: string
}

interface DirectoryListingMessage {
  type: 'directoryListing'
  cityId: string
  path: string
  entries: DirectoryEntry[]
  error?: string
}

type Resolver = (result: DirectoryListingResult) => void

export class DirectoryListingClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, Resolver[]>()

  /**
   * Update the WebSocket reference. Called from `main.ts` on every
   * `onSocketOpen` so a reconnect picks up the live socket without
   * tearing down the client. Pending promises against a stale socket
   * are kept around — they'll resolve once the new socket delivers a
   * matching `directoryListing` (or be GC'd when the consumer gives up).
   */
  setWebSocket(ws: WebSocket | null): void {
    this.ws = ws
  }

  /**
   * Request a listing for `(cityId, path)`. Resolves with `entries` (and
   * optional `error`) when the server replies. If the WS isn't open,
   * resolves immediately with an empty list + reason so the caller can
   * render an "offline" state instead of hanging.
   *
   * Idempotent on the wire: second call for an in-flight key joins the
   * existing waiter list rather than re-sending. The receiver (callback
   * passed to `handleMessage`) drains every waiter on response.
   */
  request(cityId: string, path: string): Promise<DirectoryListingResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ entries: [], error: 'WebSocket not connected' })
    }
    const key = keyOf(cityId, path)
    return new Promise<DirectoryListingResult>((resolve) => {
      const waiters = this.pending.get(key) ?? []
      const isFirst = waiters.length === 0
      waiters.push(resolve)
      this.pending.set(key, waiters)
      // First waiter triggers the WS request. Subsequent waiters in the
      // same tick share the round-trip — useful for the tree's first
      // render where the focused city + a few cached opens fire at once.
      if (isFirst) {
        this.ws!.send(JSON.stringify({ type: 'listDirectory', cityId, path }))
      }
    })
  }

  /**
   * Receive a server message. Returns true if it was a `directoryListing`
   * we resolved against; false otherwise. The `main.ts` wiring previously
   * cooperated with `CityHUDFileTree` (which also wanted to see the same
   * message) by deliberately *not* consuming — Stage I retired that
   * second consumer, so we're now the only handler and the boolean is
   * effectively informational.
   */
  handleMessage(message: unknown): boolean {
    const msg = message as Partial<DirectoryListingMessage>
    if (msg.type !== 'directoryListing') return false
    if (typeof msg.cityId !== 'string' || typeof msg.path !== 'string') return false
    const key = keyOf(msg.cityId, msg.path)
    const waiters = this.pending.get(key)
    if (!waiters || waiters.length === 0) return false
    this.pending.delete(key)
    const result: DirectoryListingResult = {
      entries: msg.entries ?? [],
      error: msg.error,
    }
    for (const resolve of waiters) resolve(result)
    return true
  }

  /**
   * Test/HMR escape hatch: resolve every pending waiter with an empty
   * result so awaiters don't deadlock if the WS tears down mid-flight.
   * Currently unused by production code; included so HMR teardown can
   * wire it without touching internals.
   */
  flushPending(reason = 'WebSocket closed'): void {
    const waiters = [...this.pending.values()].flat()
    this.pending.clear()
    for (const resolve of waiters) {
      resolve({ entries: [], error: reason })
    }
  }
}

function keyOf(cityId: string, path: string): string {
  return `${cityId}:${path}`
}
