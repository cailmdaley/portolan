---
title: 'Iteration 20: worker force simulation + wandering'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T21:08:06.76266+01:00
closed-at: 2026-01-31T21:19:21.186628+01:00
close-reason: 'Implemented worker force simulation. Workers now wander near their city using force-directed movement: (1) Created WorkerRenderer.ts with physics simulation - attraction to home city (but pushes away if too close), repulsion from other workers, random wander force. (2) Workers spawn 1-2.5 units from city center, can wander up to 3.5 units. (3) Click detection uses world position (getWorkerAtPosition) instead of hex. (4) Removed hex selection ring for workers (they move). (5) Cleaned up unused hex code from ZoneRenderer. Workers gently drift and avoid each other - Marauder''s Map style.'
---
