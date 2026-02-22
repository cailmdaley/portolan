---
title: The Map
status: open
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T17:18:00.759865+01:00
outcome: 'The tapestry renders as a force-directed graph: nodes positioned by physics simulation, edges as curved Bézier strands. Section columns run left to right; interior fibers float within their section''s column.'
---

On first load, you see only section nodes — the skeleton. Interior fibers are in the fog: present at low opacity, blurred, clickable but not yet legible. Fog is not absence. Everything is there; revelation is the interaction. Each section shows a strip of dots along its bottom edge — one per interior neighbor, colored by staleness — a preview of what you'd find inside.

Section nodes pin their horizontal positions after a burn-in phase, forming columns that read left to right by depth. Interior nodes float within their section's column, pulled by link forces toward their parent. The layout feels organic because it is: each node is an ellipse deformed by Perlin-like noise seeded from its ID, so every node has a unique but reproducible shape. Two concentric rings at different scales give each node a sense of depth.

The palette is warm and cartographic — aged vellum background, ink-colored edges, staleness encoded in color: forest green for fresh evidence, wine red for stale, umber for no evidence. The tapestry should feel like something you'd encounter in a manuscript room, not a project tracker.
