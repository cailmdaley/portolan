---
title: CityPanel click detection unreliable on canvas
status: closed
kind: bug
tags:
    - '[hexarchy]'
priority: 2
created-at: 2026-01-25T17:03:04.202273+01:00
closed-at: 2026-01-25T17:25:25.697576+01:00
close-reason: Verified working - click detection is reliable. Was a false report.
---

## Problem
Clicking on city hexes in the canvas often fails to open the CityPanel. Requires multiple clicks or precise positioning.

## Observations
- Worker hexes seem to respond more reliably than city hexes
- The "pointer" cursor change (added in iteration 2) works, but clicks don't always register
- May be related to hex hit detection math or z-ordering with workers

## Where to look
- `src/main.ts` - canvas click handler
- `src/render/HexGrid.ts` - hex hit detection

## Workaround
Keep clicking until it works, or click near the edge of the city hex away from workers.
