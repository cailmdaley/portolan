---
title: 'Pattern: Force Touch events are additive to normal mouse events'
status: closed
kind: spec
priority: 2
depends-on:
    - force-touch-focus-terminal-new-ff7e89f1
created-at: 2026-01-30T17:25:47.109845+01:00
closed-at: 2026-01-30T17:25:47.109847+01:00
close-reason: |-
    Force Touch (webkitmouseforcedown, webkitmouseforceup, etc.) fires IN ADDITION to normal mouse event sequence (mousedown → mouseup → click). The click still fires on force touch release.

    **Implication:** If you show UI on webkitmouseforcedown, the subsequent click will fire and may dismiss it.

    **Solution:** Set a flag on webkitmouseforcedown, use capture-phase document click listener to intercept and stopPropagation when flag is set:

    ```typescript
    let forceTouchFired = false

    element.addEventListener('webkitmouseforcedown', () => {
      forceTouchFired = true
      // show context menu
    })

    document.addEventListener('click', (e) => {
      if (forceTouchFired) {
        e.stopPropagation()
        forceTouchFired = false
      }
    }, true) // capture phase
    ```

    Related: pattern-event-handler-d26b6bae
---
