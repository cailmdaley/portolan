---
title: 'Iteration 19: ink-style worker markers'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T20:56:39.988609+01:00
closed-at: 2026-01-31T21:04:55.400815+01:00
close-reason: 'Replaced worker 3D hex extrusions with ink-style circular markers. Changes: (1) Workers now render as small dark circles (0.12 radius) with dark ink outline, matching port-style aesthetic; (2) Marker colors still indicate status (PALETTE.workerActive vs workerIdle); (3) Activity decals repositioned using screenToWorld for consistency; (4) Created createWorkerLabel() for italic handwritten names - labels render but may need visibility tuning in future iteration; (5) Breathing animation still works with 2D markers. Result: Workers no longer visually dominate the map with 3D blocks - they''re subtle ink dots like the Marauder''s Map.'
---
