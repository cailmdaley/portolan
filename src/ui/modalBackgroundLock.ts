/**
 * Mark every body sibling of `modalContainer` as `inert` + `aria-hidden`,
 * so screen readers and keyboard focus can't reach the map or chrome bar
 * while a full-viewport overlay is on top.
 *
 * Returns an unlock function that restores each sibling's prior `inert`
 * and `aria-hidden` state. Symmetric save/restore composes cleanly when
 * modals stack: the inner modal's lock captures the outer modal's prior
 * (non-inert) state and restores to that on close, leaving the outer
 * modal's own lock undisturbed.
 *
 * Without this, agent-browser snapshots (and screen readers) see every
 * city label and the chrome bar's worker birds alongside the modal —
 * `aria-modal="true"` alone doesn't hide background siblings.
 *
 * (Pre-Stage-I, this helper also exempted the `GlobalSearchPalette`'s
 * `gs-palette` / `gs-backdrop` siblings so it could layer over modals
 * Cmd-K-style; the palette retired in Stage C+E and its disk file in
 * Stage I, so the carve-out is gone.)
 */
export function lockModalBackground(modalContainer: HTMLElement): () => void {
  const restorers: Array<() => void> = []
  for (const child of Array.from(document.body.children)) {
    if (child === modalContainer) continue
    if (!(child instanceof HTMLElement)) continue
    const prevInert = child.inert
    const prevAriaHidden = child.getAttribute('aria-hidden')
    child.inert = true
    child.setAttribute('aria-hidden', 'true')
    restorers.push(() => {
      child.inert = prevInert
      if (prevAriaHidden === null) child.removeAttribute('aria-hidden')
      else child.setAttribute('aria-hidden', prevAriaHidden)
    })
  }
  return () => {
    while (restorers.length > 0) restorers.pop()!()
  }
}
