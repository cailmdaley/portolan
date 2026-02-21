---
title: Edge strands
tags:
    - tapestry:portolan
depends-on:
    - tapestry-rendering-0a402a96
created-at: 2026-02-21T19:11:37.463757+01:00
outcome: Each dependency edge is drawn as multiple cubic Bezier strands with per-strand opacity falloff, seeded random tension, and control point offsets — giving edges a fibrous, textile quality.
---

Each dependency edge in the tapestry is drawn as multiple parallel strands — one per ring scale (currently `RING_SCALES = [1.0, 1.15]`, so 2 strands per edge). Each strand is a cubic Bezier SVG path connecting the source and target node ellipses, giving edges the visual texture of threads rather than simple lines.

Strand parameters are seeded from a hash of the source and target IDs, making them deterministic but visually varied. Tension ranges from 0.4 to 0.5, and two control point offsets (`cpOffset1`, `cpOffset2`) vary by up to ±4px. The start and end points are computed by `ellipsePoint()`, placed on the node's ellipse at a spread angle of ±0.15π radians — so strands fan slightly at their endpoints rather than converging to a single point.

Each strand's opacity is computed by `ringOpacity(strandIndex) * 0.4`, with outer strands dimmer than inner ones. The stroke color inherits the target node's staleness color (teal for fresh, wine for stale, umber for no-evidence). All strands use 1px width with round line caps. The `updateEdgePath()` function recomputes Bezier paths on every simulation tick, so strands flex smoothly as nodes are dragged or settle.
