---
title: Remove HexGrid entirely
status: open
kind: task
priority: 2
depends-on:
    - iteration-26-coastline-a68d3d98
created-at: 2026-01-31T23:55:05.06642+01:00
---

# Remove HexGrid Entirely

Now that cities and workers are positioned by the coastline, the HexGrid is vestigial.

## What HexGrid currently does

1. **Mesh keying** — `hexGrid.hexKey(city.hex)` for Map keys → replace with city ID
2. **Click detection** — `getHexAtPosition()` → replace with raycasting to labels
3. **Fallback positions** — `axialToCartesian()` → no longer needed (coastline provides positions)
4. **Coordinate conversion** — various places → remove entirely

## Files to modify

- `src/render/ZoneRenderer.ts` — main usage
- `src/render/WorkerRenderer.ts` — some fallback usage
- `src/render/HexGrid.ts` — delete entirely
- `src/state/types.ts` — remove `HexCoord` type if unused elsewhere

## Steps

1. Change mesh keying from hex key to city ID
2. Replace click detection with raycasting to city/worker label meshes
3. Remove all `hexGrid.axialToCartesian()` calls (coastline provides positions)
4. Remove HexGrid import and construction
5. Delete HexGrid.ts
6. Clean up any remaining hex-related types

## Notes

- Workers and cities now get positions from `cityCoastlinePositions`
- Click detection can use `raycaster.intersectObjects()` on label meshes
- May need to store label meshes separately for efficient raycasting
