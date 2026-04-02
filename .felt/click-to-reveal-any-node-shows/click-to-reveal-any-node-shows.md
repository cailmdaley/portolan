---
title: 'Click-to-reveal: any node shows 1-hop neighborhood'
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-21T20:30:06.490009+01:00
outcome: Clicking any node adds it to expandedNodes and calls updateTierVisibility(), which reveals the node's 1-hop neighborhood (upstream + downstream dependsOn links). Click the selected node again to deselect (toggles in drag handler). Click background collapses to skeleton. updateHighlighting() dims non-connected nodes to 0.3 opacity, connected nodes to 0.7, selected to 1.0.
---

(click-to-reveal-any-node-shows)=
# Click-to-reveal: any node shows 1-hop neighborhood
