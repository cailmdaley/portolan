---
title: Organic shapes
status: open
tags:
    - tapestry:portolan
depends-on:
    - tapestry-rendering-0a402a96
created-at: 2026-02-21T17:18:41.447033+01:00
outcome: Nodes use 64-point ellipses with Perlin-like noise deformation (amplitude 7%). Each node gets a deterministic seed from its ID hash. Concentric rings at scales [1.0, 1.15] create depth. Edges use cubic Bezier curves with per-strand offsets.
---

Tapestry nodes are not rectangles or circles. Each is a 64-point ellipse deformed by Perlin-like noise — a seed derived from the fiber's ID produces a unique but reproducible organic shape. No two nodes look identical, and the same node always looks the same. This matters: the shape becomes a visual fingerprint that makes individual nodes recognizable across sessions.

The deformation amplitude is modest (about 7% of the ellipse radius), so nodes remain clearly elliptical while having a handmade quality. Two concentric rings at scales 1.0 and 1.15 — drawn in the staleness color with increasing opacity toward the center — give each node a sense of material depth, like something pressed or dyed rather than drawn with a compass.

Edges are cubic Bézier curves, not straight lines. The control points lean toward the midpoint of the canvas, giving edges a slight arc that makes overlapping strands distinguishable. During dragging, edges develop a slight sag that springs back when released — physical weight, not instant elasticity. These details are not decoration. They make the tapestry feel like an artifact rather than a diagram.
