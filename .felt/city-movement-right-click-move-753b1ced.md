---
title: 'City movement: right-click → Move City → click destination'
status: closed
kind: task
priority: 2
depends-on:
    - pattern-relative-worker-d14155bf
    - pattern-move-mode-ui-state-3e05b640
created-at: 2026-01-22T16:39:03.392397+01:00
closed-at: 2026-01-22T16:39:09.769199+01:00
close-reason: |-
    Implemented city repositioning via context menu.

    **Flow:**
    1. Right-click city → 'Move City' option
    2. Cursor changes to crosshair (move mode)
    3. Click destination hex → city moves
    4. Escape cancels move mode

    **Files changed:**
    - server/src/MessageRouter.ts — MoveCityMessage type, onMoveCity handler
    - server/src/CityManager.ts — moveCity() updates in-memory position
    - server/src/CityPersistence.ts — updatePosition() persists to ~/.hexarchy/cities.json
    - server/src/index.ts — handleMoveCity() wires it together
    - src/main.ts — movingCityId state, context menu option, click handler

    **Key insight:** Workers auto-update because buildState() calculates absolute positions as city.position + workerHex. No worker logic needed.
---
