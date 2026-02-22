---
title: Section expand
tags:
    - tapestry:portolan
depends-on:
    - tapestry-interaction-74c5f450
    - sections-concept-e9d0c47a
created-at: 2026-02-21T19:11:42.281701+01:00
outcome: Clicking a section node toggles its expansion, revealing 1-hop interior neighbors. Clicking the background collapses all sections back to the skeleton view.
---

The tapestry opens in skeleton view: only section nodes (`tier:1`) are visible, each decorated with a strip of colored dots representing its hidden interior neighbors. Clicking a section node toggles its expansion. `updateTierVisibility()` computes the visible set: all section nodes, plus the 1-hop neighbors (both upstream dependencies and downstream dependents) of every expanded section.

Visibility is applied by setting `display: none` on hidden SVG node groups and edge paths. An edge is visible only if both its source and target are visible. After toggling visibility, the simulation restarts at `alpha=0.05` so newly revealed interior nodes can settle into natural Y positions near their section parent — they were positioned during burn-in but may need minor adjustment.

Clicking the SVG background (not a node) collapses all sections back to skeleton view by clearing `expandedSections` and calling `updateTierVisibility()`. This two-tier navigation lets the tapestry scale — a 50-fiber graph starts as a clean 5-node overview, expanding to show detail on demand. The dot strip on each section acts as a preview, with dot colors showing whether interior fibers are fresh (teal), stale (wine), or lacking evidence (umber).
