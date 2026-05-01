/**
 * Local module declaration for `tinykeys`.
 *
 * Why this file exists: tinykeys ships its types under
 * `dist/tinykeys.d.ts` but its `package.json` `exports` block doesn't
 * include a `types` condition, so TypeScript's bundler resolution can't
 * see them through the `exports` map (it falls back to the top-level
 * `types` field, but the package's `exports` shape blocks that path).
 * Rather than vendor or fork, we declare just the surface we use.
 *
 * Two divergences from the upstream `.d.ts`:
 *   - The `target` parameter is widened from `Window | HTMLElement` to
 *     `EventTarget` so we can bind to `document` (capture-phase race
 *     against vellum's `/` listener — see main.ts §"Hotkeys").
 *   - `KeyBindingOptions` is the v3 shape (`event`, `capture`, `timeout`).
 */
declare module 'tinykeys' {
  export interface KeyBindingMap {
    [keybinding: string]: (event: KeyboardEvent) => void
  }

  export interface KeyBindingOptions {
    event?: 'keydown' | 'keyup'
    capture?: boolean
    timeout?: number
  }

  export function tinykeys(
    target: EventTarget,
    keyBindingMap: KeyBindingMap,
    options?: KeyBindingOptions,
  ): () => void
}
