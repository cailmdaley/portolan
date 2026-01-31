---
title: 'Iteration 23: separate coastlines per origin'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T22:05:36.239373+01:00
closed-at: 2026-01-31T22:12:05.405728+01:00
close-reason: 'Implemented per-origin coastlines. Changes: (1) CoastlineRenderer now fills closed polygons - land is INSIDE the spline loop, not top-edge-to-coastline. (2) Hatching direction corrected for CCW wound polygons - ticks point outward (sea side). (3) ZoneRenderer groups cities by originId and creates separate coastline per origin. (4) Coastline points stored per-origin for correct label positioning. (5) Label offset reduced to 0.45 for tighter positioning. Known issue: some label orientations still appear mirrored at certain angles - needs additional work in future iteration.'
---
