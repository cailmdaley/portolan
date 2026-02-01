---
title: 'Iteration 8: finalize and close spec'
status: closed
kind: task
priority: 2
depends-on:
    - city-sprites-nano-banana-21de7409
created-at: 2026-02-01T05:33:34.132666+01:00
closed-at: 2026-02-01T05:38:14.956755+01:00
close-reason: |-
    Fixed rhumb lines per user request:

    1. Removed secondary roses — only full 32-point compass roses remain
    2. All lines now align to cardinal directions (no random rotation)
    3. Compass roses avoid city positions (4-unit avoidRadius)
    4. Rhumb lines regenerate when city positions change

    Key changes:
    - RhumbLines.ts: Simplified RhumbParams (removed secondary*), added avoidPositions
    - ZoneRenderer.ts: updateRhumbLines() called when cities change, passes city positions
---
