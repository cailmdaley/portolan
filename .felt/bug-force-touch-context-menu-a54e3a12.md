---
title: 'Bug: Force Touch context menu closing immediately on release'
status: closed
kind: task
priority: 2
depends-on:
    - pattern-force-touch-events-are-531d171c
    - pattern-vite-hmr-stacks-f3ed5ac0
created-at: 2026-01-30T17:26:06.043337+01:00
closed-at: 2026-01-30T17:26:06.043339+01:00
close-reason: |-
    Fixed. Context menu appeared on force touch but vanished on release.

    **Root cause:** Two compounding issues:
    1. Force Touch release fires normal click event (webkitmouseforcedown doesn't prevent click)
    2. Vite HMR stacked multiple document click listeners, some without timing guards

    **Fix (main.ts):** Suppress click after force touch using capture-phase listener:
    - Set `forceTouchFired = true` in webkitmouseforcedown handler
    - Capture-phase document click listener checks flag, calls stopPropagation, clears flag

    **Fix (ContextMenu.ts):** Dynamic listener add/remove instead of constructor-time to avoid HMR stacking.

    Key files: src/main.ts:451-478, src/ui/ContextMenu.ts
---
