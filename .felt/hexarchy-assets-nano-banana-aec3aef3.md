---
title: 'Hexarchy Assets: Nano Banana generation, transparency workflow'
status: open
kind: spec
tags:
    - '[docs]'
priority: 2
depends-on:
    - hexarchy-overview-spatial-map-40356835
created-at: 2026-01-25T15:26:43.1953+01:00
---

For visual assets that need hand-crafted look (scrolls, banners), use Nano Banana.

## Transparency via Difference Matting

**Nano Banana cannot output true transparency.** Workaround:

```bash
# 1. Generate on WHITE
gemini --yolo "/generate 'asset on SOLID PURE WHITE #FFFFFF background. No text.'"

# 2. Edit to BLACK
gemini --yolo --resume latest -p "/edit asset.png 'Change white to SOLID PURE BLACK #000000.'"

# 3. Extract alpha mathematically
npx tsx scripts/extract_alpha.ts white.png black.png public/asset.png
```

Math: identical pixels on white/black = opaque; pixels showing background = transparent.

## Prompt Patterns

- **Compositing**: "on SOLID PURE WHITE #FFFFFF background"
- **Clean center**: "Empty center for text overlay"
- **No AI text**: "No text, no letters, no writing"
- **Style**: "Illustrated, Civilization game style" vs "NOT photographic"

## Current Assets

| Asset | Purpose |
|-------|---------|
| `banner.png` | City labels — parchment, torn edges |
| `worker-banner.png` | Worker labels — leather patch, guild aesthetic |

## Terrain Map

8K terrain on ground plane with LOD pyramid (`terrain_1k.png` through `terrain_8k.png`).

**Generation pipeline**: Center tile at 4K → outpaint N/S/E/W → optimal overlap via MSE → gradient blend → corner infill with narrow-band context.

**Style**: Civ 6/7 aesthetic — photorealistic aerial but painterly. Top-down nadir view.

## File Locations

- `nanobanana-output/` — Generated images (gitignored)
- `public/` — Production assets
- `scripts/extract_alpha.ts` — Transparency extraction
