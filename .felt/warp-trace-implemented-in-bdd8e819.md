---
title: Warp trace implemented in TapestryView
depends-on:
    - warp-trace-textile-breadcrumb-fb0f9628
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T04:16:25.854906+01:00
outcome: 'computeWarpTrace(selectedId) does BFS upstream from any selected interior node to nearest tier:1 section ancestor. Returns {nodes: Set<string>, edges: Set<string>} using edge keys ''sourceId->targetId''. updateHighlighting() now renders trace nodes at 0.9 opacity and trace edges in gold (#9A7B35, 2px). Trace is cleared on deselect. Section nodes return empty trace (already at anchor). Commit 342f37f on coastline-experiment.'
---
