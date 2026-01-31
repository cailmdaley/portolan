---
title: 'Iteration 25: worker visibility + text stability + movement behavior'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T22:23:58.000448+01:00
closed-at: 2026-01-31T22:34:35.327448+01:00
close-reason: 'Implemented worker visibility improvements: (1) Marauder''s Map ink footprint sprites replace Canvas-drawn shapes. (2) Steering behavior creates smooth walking paths without u-turns. (3) Left/right feet properly separated. (4) Standing footprints when worker stops. (5) Camera rotation set to 0° for straight-on view. Footprint trails now look hand-drawn and follow natural walking paths. See marauder-s-map-footprint-79ff3da7 for details.'
---

# Iteration 25: Worker Visibility + Text Stability + Movement Behavior

## Changes

### 1. Text size stability across zoom
- Labels maintain readable size regardless of zoom level
- Only shrink when density requires it (many labels overlapping)
- Implementation: Scale label mesh inversely with camera distance

### 2. Remove marker circles
- **Cities**: Remove brown circle markers entirely. Label IS the city.
- **Workers**: Remove position dot. Worker name label is sufficient.

### 3. City labels: truly inland + fix perpendicular
- Currently may appear centered on coastline
- Should be offset further inland from the port position
- Perpendicular-to-coastline orientation not working well — needs fix

### 4. Worker movement behavior
- **Working workers**: Move/wander around their city area (current behavior)
- **Idle workers**: Stationary. No movement at all.
- Currently all workers seem to move regardless of status

### 5. Worker trajectories
- Currently: Small wiggle around same point
- Desired: Larger wandering radius, actual walking paths
- Increase `maxWanderRadius`, decrease `damping`, tune forces

### 6. Rhumb line density
- Currently too dense, especially cardinal (red) lines
- Reduce number of roses or directions per rose
- Keep the aesthetic but dial back prominence

## Files to modify

- `src/render/ZoneRenderer.ts` — city marker removal, label offset
- `src/render/WorkerRenderer.ts` — movement logic, dot removal, label scaling
- `src/render/Camera.ts` — potentially for zoom-aware scaling
- `src/render/RhumbRenderer.ts` — reduce density

## Decisions

- Text size: both minimum AND maximum bounds
- Footprint trails: keep them for working workers
