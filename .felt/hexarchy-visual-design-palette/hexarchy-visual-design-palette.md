---
title: 'Hexarchy Visual Design: palette, typography, banners'
status: closed
tags:
    - '[docs]'
depends-on:
    - hexarchy-overview-spatial-map
created-at: 2026-01-25T15:26:41.708086+01:00
closed-at: 2026-01-31T00:56:50.154869+01:00
---

(hexarchy-visual-design-palette)=
**Porch Morning** palette — warm, antiquarian, cartographic. Like an old map or field notes.

## Colors (CSS vars in index.html)

| Name | Hex | Use |
|------|-----|-----|
| `--bg-primary` | #C8B8A8 | Ground plane, map background |
| `--bg-card` | #EDE8E0 | Panels |
| `--bg-elevated` | #FDFCFA | Elevated UI elements |
| `--text-primary` | #2E2A26 | Main text |
| `--text-secondary` | #4A4540 | Secondary text |
| `--text-muted` | #7A7368 | Muted text |
| `--gold` | #9A7B35 | City hexes, accents |
| `--accent` | #5A7B7B | Teal — working state |

## Typography

- **EB Garamond** — body, display (with small-caps for headers)
- **JetBrains Mono** — code, monospace

## Labels & Banners

Map labels use **3-slice** technique with Nano Banana assets:

| Entity | Banner | Text Color | Slice Width |
|--------|--------|------------|-------------|
| City | `banner.png` | #4A1515 (blood red) | 40px |
| Worker | `worker-banner.png` | #3D2817 (dark brown) | 150px |

**3-slice**: Left/right caps are fixed decorative ends. Middle stretches to fit text. See `ZoneRenderer.createLabel()`.

## Hex Geometry

**Critical**: axialToCartesian uses pointy-top spacing. All hex shapes need `-π/2` angle offset:

```typescript
// CORRECT (pointy-top)
const angle = (Math.PI / 3) * i - Math.PI / 2

// WRONG — causes triangle gaps
const angle = (Math.PI / 3) * i
```

## Camera

PerspectiveCamera at 45° angle, 45° rotation — Civ-like diagonal view. Drag uses sieve projection (clicked point stays under cursor).
