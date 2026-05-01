/**
 * Constants shared between `FindHost.tsx` (the vellum tab content) and
 * `main.ts` (the keystroke layer). Kept in a tiny non-React module so the
 * main bundle can import the names without forcing the React tree into
 * the initial paint — `./mount` and `./FindHost` stay behind the lazy
 * `vellumMountPromise` import.
 *
 * `FIND_SEARCH_INPUT_CLASS` is the contract main.ts uses to detect "the
 * Find search input is the active element"; FindHost stamps the class on
 * its input.
 *
 * `FIND_FOCUS_SEARCH_EVENT` is the custom event main.ts dispatches to ask
 * FindHost to focus + select its input from outside (the `/` chord, when
 * Find is already open but the input isn't focused).
 */

export const FIND_SEARCH_INPUT_CLASS = 'find-search-input'
export const FIND_FOCUS_SEARCH_EVENT = 'portolan:find-focus-search'
