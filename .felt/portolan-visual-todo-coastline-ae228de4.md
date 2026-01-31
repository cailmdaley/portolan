---
title: 'Portolan visual TODO: coastline-first architecture'
status: closed
kind: spec
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T22:54:35.528713+01:00
closed-at: 2026-01-31T23:56:56.710358+01:00
close-reason: 'Resolved by iteration 26. Coastline-first architecture implemented: coastline generated with natural flowing shape (sine waves + wobble), cities placed along it in discovery order, labels perpendicular to coast pointing inland. Green fill removed. Hexgrid removal pending in separate fiber.'
---

# Portolan Visual TODO

Architectural rethinking of coastline generation.

## Current Problems

1. **Local cities form an island** — They should be along a *coastline*, not enclosed
2. **Too smooth** — Coastlines lack the fractal irregularity of real geography
3. **Green fill looks bad** — Remove it entirely
4. **Labels not perpendicular** — City names should radiate inland from coast

## Conceptual Model

```
Local origin  →  coastline (open, grows with cities)
Remote origin →  separate coastline across water (also open)
```

Both are open coastlines with fractal character — bays, peninsulas, the full variety of real geography. Remote origins are just separated by sea, not enclosed islands.

**Coastline is discovered, not predefined.** As cities are placed:
- Coastline extends to thread through them
- Only defined where cities exist
- Fog of war hides undefined coast (it's just... sea)

---

## Phase 0: Remove Green Fill (immediate)

The green land shading isn't working. Strip it out.
- `CoastlineRenderer.ts` — remove fill polygon rendering

---

## Phase 1: Coastline Architecture Rethink

### Current approach
- All cities → closed Catmull-Rom spline → island shape
- Same for local and remote

### New approach

**All origins (open coastlines):**
- Cities define points along a coast
- Coastline is open, extends only as far as cities exist
- Remote origins are separate landmasses across water, but still open coastlines (not enclosed islands)
- "Inland" direction: northwest (fixed)

**Fractal character is essential:**
- Not just a smooth curve — bays, peninsulas, headlands, inlets
- The variety of real coastlines at multiple scales
- Some sections jut out, others curve inward
- Midpoint displacement creates this naturally

### Fractal coastline generation

Current: Chaikin smoothing only → too smooth, lacks character
Needed: Midpoint displacement → bays, peninsulas, natural irregularity

**Algorithm:**
```
1. Start with city positions as control points
2. For each segment, add midpoint with random perpendicular displacement
   - Displacement magnitude decreases with each level (self-similar)
   - Some segments push seaward (peninsulas), others push inland (bays)
3. Repeat recursively (2-3 levels)
4. Apply Chaikin for final smoothness (softens sharp corners)
```

**The goal:** When you look at a segment of coastline, it should have the same character whether zoomed in or out. Bays contain smaller bays. Peninsulas have smaller peninsulas on them. This is what makes real coastlines feel natural.

### Decisions

**Inland direction:** Northwest (fixed). Simple, consistent.

**Coastline edges:** Fade out. The ink drawing continues a short distance past the last city, then tapers — stroke gets lighter/thinner, hatching fades. Like the cartographer stopped drawing there.

---

## Phase 2: Label Perpendicularity

Once coastline architecture is solid:
1. Compute tangent at each city's position on curve
2. Anchor label at END (shore side), not center
3. Rotate perpendicular to tangent, extending inland

---

## Phase 3: Polish (future)

- Rhumb line tuning
- Worker footprint trails
- Label collision detection
- Fog of war reveal animation

---

## Reference

`reference/portolan-charts/default-2.jpg`:
- Coastlines have fractal quality — irregular at all scales
- City names perpendicular to coast, radiating inland
- No filled land — just coastline strokes + hatching
