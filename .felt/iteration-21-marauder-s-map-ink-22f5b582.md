---
title: 'Iteration 21: Marauder''s Map ink figure workers'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T21:21:12.565376+01:00
closed-at: 2026-01-31T21:35:21.376847+01:00
close-reason: 'Partial: Implemented footprint trail system (position dot, footprint meshes created on movement, fading over time) but trails not visibly rendering - likely velocity threshold or rendering layer issue. Code compiles and runs but footprints aren''t appearing. Left in place for debugging. Also: worker names still need separate zoom scaling per user request.'
---


## Comments
**2026-01-31 21:37** — Also implemented infinite map: increased vellum plane from 50 to 500 world units, rhumb/coastline radius from 50 to 250. Map now extends well beyond visible area.

