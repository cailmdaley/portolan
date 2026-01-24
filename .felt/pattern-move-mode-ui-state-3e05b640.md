---
title: 'Pattern: move mode UI — state + cursor + escape cancel'
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T16:39:31.590737+01:00
closed-at: 2026-01-22T16:39:37.160046+01:00
close-reason: |-
    UI pattern for two-click operations (select source, then destination):

    1. **State variable:** movingCityId: string | null tracks active operation
    2. **Cursor feedback:** document.body.style.cursor = 'crosshair' signals mode
    3. **Click intercept:** Check state before normal click handling
    4. **Escape cancel:** Keydown listener resets state + cursor
    5. **Auto-reset:** Clear state after successful operation

    Pattern reusable for any select-then-target interaction.
---
