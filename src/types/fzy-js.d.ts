/**
 * Ambient types for `fzy.js` — the package ships pure JS without a `.d.ts`,
 * but its public surface is small enough that declaring it inline keeps
 * client typecheck honest without reaching for an unmaintained
 * `@types/fzy.js` package.
 *
 * Mirrors the fields exported from `node_modules/fzy.js/index.js`. `score`
 * returns `Number.POSITIVE_INFINITY` when needle === haystack (fzy's
 * SCORE_MAX), and `Number.NEGATIVE_INFINITY` for no match — callers must
 * handle the infinity edges, not assume a finite range.
 *
 * Twin of `server/src/types/fzy-js.d.ts`; kept in sync deliberately.
 */

declare module 'fzy.js' {
  export const SCORE_MIN: number;
  export const SCORE_MAX: number;
  export const SCORE_GAP_LEADING: number;
  export const SCORE_GAP_TRAILING: number;
  export const SCORE_GAP_INNER: number;
  export const SCORE_MATCH_CONSECUTIVE: number;
  export const SCORE_MATCH_SLASH: number;
  export const SCORE_MATCH_WORD: number;
  export const SCORE_MATCH_CAPITAL: number;
  export const SCORE_MATCH_DOT: number;

  export function score(needle: string, haystack: string): number;
  export function positions(needle: string, haystack: string): number[];
  export function hasMatch(needle: string, haystack: string): boolean;
}
