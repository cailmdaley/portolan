---
title: 'City labels: make perpendicular to coastline'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T21:26:01.067344+01:00
closed-at: 2026-01-31T21:49:07.57939+01:00
close-reason: Implemented in iteration 16. Labels now use getCoastlineAngleAt() with improved tangent calculation (fixed lookAhead to be at least 1) and proper rotation math. Labels radiating perpendicular to coastline into land, with upside-down flip correction for readability.
---
