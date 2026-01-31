---
title: 'Iteration 16: fix perpendicular city labels'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T21:46:40.968629+01:00
closed-at: 2026-01-31T21:49:15.445788+01:00
close-reason: 'Fixed perpendicular city labels. Two changes: (1) Improved getCoastlineAngleAt() - fixed lookAhead calculation that was sometimes 0, now returns normalX/normalZ for positioning. (2) Fixed ZoneRenderer rotation - removed erroneous +π/2 offset, added upside-down text flip correction. Labels now radiate from coastline into land like authentic portolans. Closed city-labels-make-perpendicular-e91e51fa.'
---
