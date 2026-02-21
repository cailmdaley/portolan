---
title: 'Click-to-reveal: any node shows 1-hop neighborhood'
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-21T20:30:06.490009+01:00
outcome: selectNode() now calls updateTierVisibility() which adds selected node's 1-hop neighborhood (upstream + downstream) to the visible set, plus warp trace nodes (BFS up dependsOn to nearest section). computeWarpTrace() returns {nodes, edges} — edges stored as 'source→target' strings in warpTraceEdges Set, highlighted gold (#9A7B35, stroke-width 2) in updateHighlighting(). Click selected node again to deselect (toggles in drag handler). Click background collapses to skeleton + expanded sections.
---
