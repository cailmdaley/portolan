---
title: 'Design: dynamic rhumb lines follow camera focus'
status: closed
depends-on:
    - ralph-loop-autonomous-portolan
created-at: 2026-01-31T20:19:00.089772+01:00
closed-at: 2026-01-31T20:23:14.897676+01:00
---

(design-dynamic-rhumb-lines)=
# Dynamic Rhumb Lines Design

## Insight

Rhumb lines in authentic portolan charts served a navigational purpose — they showed constant compass bearing courses radiating from wind roses. Mariners would identify which line was parallel to their desired heading and sail that bearing.

The key insight: **lines radiate from where you ARE**, not from arbitrary decorative positions.

## Current State

Static web of rhumb lines from randomly-placed compass roses. Decorative, but doesn't reflect the functional meaning of portolan navigation.

## Proposed Design

### Primary Rose (Dynamic)
- **Follows camera/focus position** — always centered on current view
- Shows navigation directions FROM current viewpoint
- Could animate smoothly as camera moves
- Most visible, highest opacity

### Secondary Roses (Anchored)
- Positioned at edges/off-screen
- Lines "coming in" from the periphery
- Provides visual grounding and the characteristic web texture
- Lower opacity, static positions

### Interaction
- When you pan/zoom, the primary rose moves with you
- The peripheral roses stay anchored, creating parallax depth
- The intersection of your local rose with distant roses creates natural waypoints

## Visual Effect

This approach makes the rhumb lines feel like a navigation instrument rather than wallpaper. The map orients around your current position, just as a mariner would orient their chart.

## Implementation Notes

- `RhumbRenderer.ts` needs camera position input
- Primary rose: position = camera focus point, projected to ground plane
- Secondary roses: fixed world positions at map edges
- Consider line fading with distance from primary rose
