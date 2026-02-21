---
title: Warp trace
tags:
    - tapestry:portolan
depends-on:
    - section-expand-aae515d3
    - force-directed-layout-6d126304
created-at: 2026-02-21T19:27:13.602931+01:00
outcome: BFS from selected node upward through dependsOn finds the shortest path to the nearest section. Path edges get gold stroke and a warp-trace CSS class. All nodes on the trace become visible regardless of section expansion state.
---

When an interior node is selected, `computeWarpTrace()` runs a breadth-first search upward through `dependsOn` links to find the shortest path back to the nearest section node. The BFS uses a queue of `[currentId, pathFromStart]` tuples, tracking visited nodes to avoid cycles. When a section node is reached, the path is converted into two sets: node IDs on the path, and edge keys in `"source→target"` format.

The warp trace integrates directly into `updateTierVisibility()`. All nodes on the trace are added to the visible set, meaning they appear even if their parent section is collapsed. This lets a user click a deep interior node (from a search result or URL hash) and immediately see its context — the chain of dependencies leading back to the section skeleton.

Edges on the warp trace receive special visual treatment. In `updateTierVisibility()`, each edge checks against `warpTraceEdges` and gets the CSS class `warp-trace` applied. In `updateHighlighting()`, warp trace edges receive a gold stroke (`#9A7B35`) overriding the normal staleness color. Non-warp edges revert to `null` stroke, which restores the original staleness-based coloring. This gold thread visually connects the selected node back through the DAG to its section root.

The warp trace is recomputed on every call to `updateTierVisibility()` — it's cleared first (`this.warpTraceEdges = new Set()`) then rebuilt if a node is selected. This means deselecting a node or selecting a different one automatically updates the trace without any explicit cleanup.
