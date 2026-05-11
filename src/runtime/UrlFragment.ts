/**
 * URL-fragment ↔ navigation-state plumbing for Stage J of
 * [[ai-futures/portolan/design/constitution-portolan-navigation-layer]].
 *
 * The fragment encodes the *visible* navigation state so reload, browser
 * back/forward, Cmd-click, and copy-paste all round-trip:
 *
 *   #city=<id>             ← focused map city (always, when one is focused)
 *   #mode=<narrative|kanban|find>  ← active vellum tab; absent ⇒ vellum closed
 *   #fiber=<slug>          ← currently-open fiber (narrative mode)
 *   #file=<absolute-path>  ← currently-open file (narrative file mode)
 *   #origin=<origin-id>    ← file origin when it is not local
 *   #scope=<id|global>     ← Find/Kanban scope when it diverges from focused city
 *
 * Pre-Stage-J the fragment carried only `city` + `fiber` and was read once at
 * initial load (plus a `hashchange` listener for typed mid-session URLs). Mode
 * was a session-local memo (`lastVellumMode` in main.ts) lost on reload; Find
 * scope was internal to FindHost; closing vellum left the URL pointing at the
 * still-visible-in-history old view.
 *
 * Stage J widens the fragment to carry all of those, replaces the
 * `hashchange` polyfill with proper `pushState`/`popstate` history, and
 * funnels every navigation through the helpers in this module so the URL
 * stays the source of truth.
 *
 * Backward compatibility: `#city=X` / `#fiber=Y` URLs from Stage A–I deep
 * links keep working — `mode` defaults to `'narrative'` when a fiber slug is
 * present, otherwise vellum stays closed and the city focus alone applies.
 */

export type VellumMode = 'narrative' | 'kanban' | 'find'

/** Sentinel for an explicit "global" scope in the URL — distinct from
 *  "scope inherits from focused city" (which is encoded by omitting the
 *  scope param). The user reaches this state via the thumb-index `← index`
 *  escalation (city root → global Vellum index), the chrome bar's K / F
 *  chips when no focused city is set, the `/` hotkey ladder's global rung,
 *  or by typing the URL directly. The eyebrow ⊕ Global affordances retired
 *  with the thumb-index global-navigation constitution. */
export const SCOPE_GLOBAL = 'global' as const

export interface UrlState {
  /** Focused map city id. Set whenever `lastFocusedCityId` is set in main.ts. */
  cityId?: string
  /** Active vellum tab. Absent ⇒ vellum is closed. */
  mode?: VellumMode
  /** Currently-open fiber slug (project-relative). Only meaningful with `mode=narrative`. */
  fiberSlug?: string
  /** Currently-open file path. Only meaningful with `mode=narrative` (file mode). */
  filePath?: string
  /** File origin. Omitted for local, carried for remote file-mode links. */
  originId?: string
  /** Vellum modal scope. `undefined` ⇒ inherit from `cityId`; `'global'` ⇒ explicit global. */
  scopeCityId?: string | typeof SCOPE_GLOBAL
}

/**
 * Parse the current `window.location.hash` into a UrlState. Falls back to
 * `?city=X` / `?fiber=Y` query params for the two legacy axes (matches
 * pre-Stage-J behavior); newer params (`mode`, `file`, `scope`) live on
 * the hash only — they're set by us, never typed by the user, so the
 * legacy query-param parity isn't worth carrying forward.
 */
export function readUrlState(): UrlState {
  const hash = window.location.hash.replace(/^#/, '')
  const hashParams = hash ? new URLSearchParams(hash) : null
  const queryParams = new URLSearchParams(window.location.search)

  // Hash wins over query (matches pre-Stage-J `readUrlCityId` precedence).
  const get = (key: string): string | null =>
    hashParams?.get(key) ?? queryParams.get(key)

  const cityId = get('city') ?? undefined
  const fiberSlug = get('fiber') ?? undefined
  const filePath = hashParams?.get('file') ?? undefined
  const originId = hashParams?.get('origin') ?? undefined
  const scopeRaw = hashParams?.get('scope')
  const modeRaw = hashParams?.get('mode')

  const mode: VellumMode | undefined =
    modeRaw === 'narrative' || modeRaw === 'kanban' || modeRaw === 'find'
      ? modeRaw
      : undefined

  const scopeCityId: UrlState['scopeCityId'] =
    scopeRaw === SCOPE_GLOBAL
      ? SCOPE_GLOBAL
      : scopeRaw && scopeRaw.length > 0
        ? scopeRaw
        : undefined

  return {
    cityId,
    mode,
    fiberSlug,
    filePath,
    originId,
    scopeCityId,
  }
}

/**
 * Encode a UrlState as a `#…` fragment string suitable for `pushState` /
 * `replaceState`. Returns `''` (empty string) when no axes are set —
 * callers detect "no fragment needed" and pass `''` to history APIs to
 * keep the URL clean. Param order is fixed (city, mode, fiber/file/origin,
 * scope) so identical states encode to identical strings; the
 * `urlStatesEqual` check below relies on that.
 */
export function encodeUrlState(state: UrlState): string {
  const params = new URLSearchParams()
  // Order matters for stable string equality; URLSearchParams preserves
  // insertion order in toString().
  if (state.cityId) params.set('city', state.cityId)
  if (state.mode) params.set('mode', state.mode)
  if (state.fiberSlug) params.set('fiber', state.fiberSlug)
  if (state.filePath) params.set('file', state.filePath)
  if (state.originId && state.originId !== 'local') params.set('origin', state.originId)
  if (state.scopeCityId) params.set('scope', state.scopeCityId)
  const encoded = params.toString()
  return encoded ? `#${encoded}` : ''
}

/** Structural equality on UrlState — same fields, same values. Used to
 *  short-circuit `pushState` calls when the prospective URL matches
 *  current, which avoids polluting history with no-op entries. */
export function urlStatesEqual(a: UrlState, b: UrlState): boolean {
  return (
    (a.cityId ?? '') === (b.cityId ?? '') &&
    (a.mode ?? '') === (b.mode ?? '') &&
    (a.fiberSlug ?? '') === (b.fiberSlug ?? '') &&
    (a.filePath ?? '') === (b.filePath ?? '') &&
    (a.originId ?? '') === (b.originId ?? '') &&
    (a.scopeCityId ?? '') === (b.scopeCityId ?? '')
  )
}

/**
 * History-aware writer for the URL fragment.
 *
 * Writes go through `pushState` (default) or `replaceState` (one-off
 * silent updates that shouldn't add a history entry — e.g., the initial-
 * load reconcile after a typed `#city=…&mode=…` URL).
 *
 * `popstate` (back/forward) hands the freshly-applied state back to the
 * subscriber; the subscriber converges UI to it and must wrap the
 * convergence in `runSuppressed(...)` so the open-paths' incidental URL
 * writes don't double-push.
 *
 * `runSuppressed` is reentrant via a counter so nested
 * `runSuppressed(() => runSuppressed(...))` doesn't end early.
 */
export class UrlFragmentSync {
  private suppressDepth = 0
  private popHandler: ((state: UrlState) => void | Promise<void>) | null = null
  private boundPopstate: () => void

  constructor() {
    this.boundPopstate = () => {
      if (!this.popHandler) return
      // popstate fired by browser back/forward — UI is stale, converge.
      // The handler will likely write URL itself in the process; suppress
      // those writes since the URL is already where it should be. Async
      // handlers stay suppressed across their lifetime via the
      // promise-aware runSuppressed below.
      const handler = this.popHandler
      this.runSuppressed(() => handler(this.read()))
    }
    window.addEventListener('popstate', this.boundPopstate)
  }

  dispose(): void {
    window.removeEventListener('popstate', this.boundPopstate)
    this.popHandler = null
  }

  /** Subscribe to popstate convergence. Only one subscriber is supported
   *  (main.ts owns the convergence path); replacing an existing
   *  subscriber drops the previous one. Returns an unsubscribe handle.
   *  Handlers may return a Promise — `runSuppressed` defers releasing
   *  the suppression flag until the returned promise settles, so async
   *  convergence stays under suppression for its full lifetime. */
  setPopHandler(handler: (state: UrlState) => void | Promise<void>): () => void {
    this.popHandler = handler
    return () => {
      if (this.popHandler === handler) this.popHandler = null
    }
  }

  read(): UrlState {
    return readUrlState()
  }

  /**
   * Push a new URL state. No-op when:
   *   - we're inside `runSuppressed` (popstate convergence),
   *   - the prospective state matches the current URL (don't pollute
   *     history with identical entries — happens when `commitVellumMode`
   *     is called twice with the same mode during an open).
   */
  push(state: UrlState): void {
    if (this.suppressDepth > 0) return
    if (urlStatesEqual(state, this.read())) return
    const fragment = encodeUrlState(state)
    // Use `${pathname}${search}${fragment}` rather than the bare fragment
    // so query params (e.g., the `?vellumDebug=…` deep-link) survive the
    // push. The browser preserves them when fragment is the only change,
    // but being explicit keeps the URL stable across all push paths.
    const url = `${window.location.pathname}${window.location.search}${fragment}`
    window.history.pushState(null, '', url)
  }

  /** Replace the current URL state (no history entry). Used during
   *  initial-load reconciliation when the user typed a deep link and we
   *  don't want a back step that would land on the same URL again. */
  replace(state: UrlState): void {
    if (this.suppressDepth > 0) return
    if (urlStatesEqual(state, this.read())) return
    const fragment = encodeUrlState(state)
    const url = `${window.location.pathname}${window.location.search}${fragment}`
    window.history.replaceState(null, '', url)
  }

  /** Run `fn` with URL writes suppressed. Reentrant via a counter; nested
   *  calls don't release suppression early. Promise-aware: when `fn`
   *  returns a thenable, the depth counter defers release until the
   *  promise settles, so async convergence (e.g., `applyUrlState` with a
   *  /fiber-locate roundtrip) stays under suppression for its full
   *  lifetime. Used by the popstate handler so the open-paths'
   *  incidental `push()` calls during convergence don't double-push. */
  runSuppressed<T>(fn: () => T): T {
    this.suppressDepth += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.suppressDepth -= 1
    }
    try {
      const result = fn()
      const thenable = result as { then?: unknown } | null | undefined
      if (thenable && typeof thenable.then === 'function') {
        ;(result as unknown as Promise<unknown>).then(release, release)
        return result
      }
      release()
      return result
    } catch (err) {
      release()
      throw err
    }
  }

  isSuppressed(): boolean {
    return this.suppressDepth > 0
  }
}
