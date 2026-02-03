---
title: 'Portolan visual redesign: bottom-up aesthetic rebuild'
status: closed
kind: spec
priority: 2
created-at: 2026-01-31T17:45:24.661053+01:00
closed-at: 2026-02-03T01:15:10.300225+01:00
close-reason: Design direction established. Vellum substrate, coastline aesthetic, city sprites, worker ships. Philosophy captured in vellum-design-philosophy fiber. Implementation is hybrid hex+coastline, not pure bottom-up rebuild.
---

# Portolan Visual Redesign

Rebuilding the visual language from the bottom up, informed by historical portolan charts.

## Philosophy

**The sea is the canvas, the land is the interruption.**

Portolan charts were navigation tools. Everything serves wayfinding. The beauty emerges from function — rhumb lines exist because sailors needed compass bearings, not because cartographers wanted decoration.

Our map serves navigation too: finding Claude sessions, understanding what's active, clicking to go there.

## Layers (Bottom to Top)

### 1. Vellum — The Substrate
The parchment itself. Warm, aged, alive with natural variation.
- Edge darkening (hands held it there)
- Subtle color variation (animal skin isn't uniform)
- Optional: fold lines, wear patterns
- **No texture images** — procedurally generated

### 2. Rhumb Lines — The Geometry
Compass bearings radiating from wind roses.
- Thin lines, mostly red/brown
- Emanate from cities (navigation origins)
- Create the signature crisscross pattern
- Functional: show relationships between places

### 3. Coastline — The Boundary
Where sea meets land. Simple ink strokes.
- Jagged/scalloped line aesthetic
- Place names perpendicular to coast
- Interior mostly empty
- Mountains as line hatching, not texture

### 4. Cities & Workers — The Markers
Wind roses and place markers.
- Cities as compass roses (navigation origins)
- Workers as smaller markers clustered nearby
- Colored shields/banners for identification
- Minimal, functional iconography

### 5. Labels — The Names
Text that names places.
- Written along features, not floating
- Perpendicular to coastlines
- Period-appropriate lettering (but legible)

## Color Palette

| Element | Color | Notes |
|---------|-------|-------|
| Vellum base | #E8DCC8 → #D4C4A8 | Warm cream, varies |
| Edge aging | #B8A888 → #8A7A5A | Darker, more saturated |
| Rhumb lines | #8B4513 | Sienna brown |
| Coastline ink | #2A2420 | Near-black brown |
| Sea (if shown) | Vellum shows through | Not filled |
| City accent | #9A7B35 | Gold (existing) |
| Worker accent | #5A7B7B | Teal (existing) |

## Implementation Path

1. **Canvas-design** — Static visual study of vellum
2. **Playground** — Interactive parameter exploration
3. **Three.js shader** — Procedural vellum in WebGL
4. Repeat for each layer

## Reference

Images in `reference/portolan-charts/`:
- yale_1015869.jpg, yale_16762930.jpg (Yale Beinecke collection)
- default.jpg through default-4.jpg

## Current Status

Starting with Layer 1: Vellum.
