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
 * The slash `GlobalSearchPalette` is itself a modal overlay split across
 * two body siblings (`gs-palette` + `gs-backdrop`), so keep both parts out
 * of the inerted background set when it layers over another modal.
 */
export function lockModalBackground(modalContainer: HTMLElement): () => void {
  const restorers: Array<() => void> = []
  for (const child of Array.from(document.body.children)) {
    if (child === modalContainer) continue
    if (!(child instanceof HTMLElement)) continue
    if (child.classList.contains('gs-palette') || child.classList.contains('gs-backdrop')) continue
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
