---
title: 'Terrain background: tiled satellite map with hex grid overlay'
status: closed
depends-on:
    - visual-polish-wishlist-v1
created-at: 2026-01-21T10:34:31.108331+01:00
closed-at: 2026-01-22T11:53:44.61147+01:00
---

(terrain-background-tiled)=
## Context

Alternative to per-hex tile sprites — use a large satellite-style terrain image as background with hex grid lines overlaid. Simpler to implement, gives Civ-like "wow" factor.

## Architecture

- Single image (or tiled images) rendered on ground plane at Y=-0.05
- Empty hexes show only edge lines (no fill) so terrain shows through
- Cities/workers render on top with filled hexes
- Eventually: fog of war to reveal terrain near workers/cities

## Decisions Made

1. **Top-down perspective** — images generated as true satellite/aerial view, not angled. Three.js camera provides the 45° viewing angle.

2. **Southwest lighting** — matches camera position (45° pitch, 45° rotation). Light from bottom-left, shadows to upper-right.

3. **Square tiles (1:1)** — simpler tiling than 16:9

4. **Pointy-top hex geometry** — 6 sides at specific angles, coastlines follow hex edge normals

5. **Tiling strategy** — Generate 6 edge tiles first (coastlines), then center last. Each tile is one side of the continental hexagon.

6. **Style: photorealistic aerial** — like Google Earth but slightly painterly. NOT fantasy illustration (too cute), NOT oblique angle (double-projects).

## Hex Side Geometry

```
Side 1: NE-facing → coastline ~150° (NNW-SSE)
Side 2: NW-facing → coastline ~30° (NNE-SSW)
Side 3: W-facing  → coastline ~90° (N-S vertical)
Side 4: SW-facing → coastline ~30° (NNE-SSW)
Side 5: SE-facing → coastline ~150° (NNW-SSE)
Side 6: E-facing  → coastline ~90° (N-S vertical)
```

## Files

- `terrain-prompt.md` — generation prompt template with all tile specs
- `public/terrain.png` — current terrain image (placeholder)
- `nanobanana-output/` — generated terrain experiments

## Implementation Status

- [x] Ground plane renders terrain texture
- [x] Empty hexes are transparent (lines only)
- [x] Hex lines semi-transparent black (0.12 opacity)
- [ ] Generate all 6 edge tiles
- [ ] Generate center tile
- [ ] Implement multi-tile rendering
- [ ] Fog of war

## Open Questions

- How to get 4K from Gemini via nanobanana CLI?
- Exact tile positioning/seam handling?
