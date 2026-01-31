---
title: 'Iteration 22: fix worker footprints + visible wandering'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T21:52:07.082363+01:00
closed-at: 2026-01-31T22:02:50.869489+01:00
close-reason: 'Fixed worker footprint trails. Issues found and fixed: (1) footprintSpacing was 0.25 world units but workers oscillate with small wandering motions - reduced to 0.12 to ensure footprints are placed before workers reverse direction. (2) velocity threshold was 0.01 but actual velocity magnitudes are ~0.05-0.07, meaning the check was passing but footprints weren''t placed due to spacing. (3) Increased wanderStrength from 0.5 to 1.5, reduced damping from 0.90 to 0.85, and increased wanderFrequency for more visible movement. Footprints now appear as subtle dark ink marks that fade over ~2.3 seconds. The Marauder''s Map effect is working - workers wander near cities and leave fading trail of footprints.'
---
