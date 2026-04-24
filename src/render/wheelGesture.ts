// Shared wheel-gesture arbitration so a zoom gesture that starts on the map
// doesn't get hijacked when the cursor crosses over a pin (and vice-versa).
//
// Problem: wheel events don't have a pointerdown/move/up lifecycle, so there's
// no native "gesture started here" signal. Without coordination, rolling the
// wheel while the camera zooms the cursor onto a pin causes the pin's wheel
// handler to take over mid-gesture — the zoom stops, text scrolls (or the
// card resizes if Cmd was held) inside the card, which is never what the
// user wanted.
//
// Arbitration: the first wheel event in a burst locks the active target to
// either 'card' or 'canvas'. Every subsequent wheel within IDLE_MS of the
// last one routes to the same target, regardless of cursor position. After
// IDLE_MS of quiet, the lock clears and the next wheel starts a fresh
// gesture.
//
// Both `Camera`'s window-level wheel handler and `DomPinLayer`'s pin wheel
// handler call `trackWheelEvent(ownSide)` on every wheel event. The return
// value tells each handler whether *it* owns the active gesture; if not,
// the handler should no-op and let the other side take the event.

const IDLE_MS = 200

let active: 'card' | 'canvas' | null = null
let timer: number | null = null

/** Refresh the gesture's idle timer and return the active target. If no
 *  gesture is currently active, `ownSide` becomes the target and is returned.
 *  Called by both sides of the arbitration on every wheel event. */
export function trackWheelEvent(ownSide: 'card' | 'canvas'): 'card' | 'canvas' {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    active = null
    timer = null
  }, IDLE_MS)
  if (active === null) active = ownSide
  return active
}
