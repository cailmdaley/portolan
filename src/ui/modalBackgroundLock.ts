/**
 * Mark every body sibling of `modalContainer` as `inert` + `aria-hidden`,
 * so screen readers and keyboard focus can't reach the map, pinned cards,
 * or recent-worker bar while a full-viewport overlay is on top. The global
 * search palette is intentionally left interactive — it's the one overlay
 * we expect to layer over an open modal (Cmd-K-style navigation).
 *
 * Returns an unlock function that restores each sibling's prior `inert`
 * and `aria-hidden` state. Symmetric save/restore composes cleanly when
 * modals stack: the inner modal's lock captures the outer modal's prior
 * (non-inert) state and restores to that on close, leaving the outer
 * modal's own lock undisturbed.
 *
 * Without this, agent-browser snapshots (and screen readers) see every
 * city label, pinned-card region, and the "Recent workers" nav alongside
 * the modal — `aria-modal="true"` alone doesn't hide background siblings.
 */
export function lockModalBackground(modalContainer: HTMLElement): () => void {
  const restorers: Array<() => void> = []
  for (const child of Array.from(document.body.children)) {
    if (child === modalContainer) continue
    if (!(child instanceof HTMLElement)) continue
    // GlobalSearchPalette layers on top of modals (Cmd-K-style nav).
    if (child.classList.contains('gs-palette')) continue
    if (child.classList.contains('gs-backdrop')) continue
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
