---
title: Node anatomy
depends-on:
    - organic-shapes-009130ed
created-at: 2026-02-21T19:27:11.602931+01:00
outcome: Each node is an SVG group with concentric fill layers (opacity 0.12–0.24), ring strokes at scales [1.0, 1.15], a centered text label (split across two lines for 3+ word titles), and for sections, a staleness-colored dot strip showing interior neighbors.
---

Each tapestry node is rendered as an SVG `<g>` element containing several layered components. The base dimensions are `NODE_RX=52` and `NODE_RY=18`, scaled up by 1.5x for section nodes. A deterministic seed derived from `hashString(node.id) / 1000000` ensures each node has a unique but reproducible organic shape.

The fill layers render back-to-front through `RING_SCALES` ([1.0, 1.15]). Each layer is a `<path>` with class `tapestry-node-fill`, using the `organicEllipse()` function to generate a 64-point deformed ellipse. Fill opacity increases from outer to inner: `0.12 + (RING_COUNT - 1 - i) * 0.06`, creating a subtle density gradient. The fill color comes from `stalenessColor()` — forest green for fresh, wine red for stale, umber for no-evidence.

Ring strokes are drawn on top of fills, also iterating through `RING_SCALES`. The innermost ring (index 0) gets `stroke-width: 0.8` and slightly reduced opacity (85%), while outer rings use `stroke-width: 0.5` at full `ringOpacity()`. This gives the core ring a subtly bolder presence.

Labels use `shortName()` (first 3 words of the title). Titles with 3+ words split across two `<text>` elements (y=-4 and y=8); shorter titles center at y=3. Section nodes use slightly larger font sizes (11px vs 9.5-10px). For section nodes, a dot strip at the bottom shows interior 1-hop neighbors as staleness-colored circles — filled for evidence-bearing fibers, hollow for no-evidence — with a `+N` overflow indicator when more than 8 fibers exist.
