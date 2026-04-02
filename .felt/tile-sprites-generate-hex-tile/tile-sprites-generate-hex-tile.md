---
title: 'Tile sprites: generate hex tile textures with transparency workflow'
status: closed
depends-on:
    - banner-transparency-not-working
created-at: 2026-01-18T22:07:02.27197+01:00
closed-at: 2026-01-31T00:59:39.767552+01:00
---

(tile-sprites-generate-hex-tile)=
## Context

User wants to eventually use Nano Banana generated sprites for hex tiles (grass, forest, mountain, water, etc.). Same transparency workflow applies.

## Approach

1. Generate tile variants on white background
2. Edit each to black background
3. Extract alpha via `extract_alpha.ts`
4. Load as texture atlas or individual sprites

## Considerations

- **Texture atlas**: Pack tiles into single image, UV map in shader
- **Instanced rendering**: One geometry, many instances with different textures
- **Edge blending**: Tiles need to blend at edges (see threejs-hex-map techniques)
- **Seamless tiling**: Ensure textures tile properly at hex boundaries

## Reference

- [threejs-hex-map](https://github.com/Bunkerbewohner/threejs-hex-map) — edge blending, texture atlas approach
- Current banner workflow documented in CLAUDE.md "Asset Generation" section
