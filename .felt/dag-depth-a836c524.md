---
title: DAG depth
tags:
    - tapestry:portolan
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T19:11:22.995121+01:00
outcome: computeDepth() recursively finds the longest dependency chain to each node. Depth determines tier, which sets horizontal position in the left-to-right DAG layout.
---

The DAG layout positions nodes left-to-right by dependency depth. `computeDepth()` in `TapestryView.renderDAG()` recursively resolves each node's depth: a root node (no dependencies) has depth 0, and every other node's depth is one plus the maximum depth among its parents. Cycle detection via a `visited` set prevents infinite recursion in malformed graphs.

Depth determines the node's horizontal tier. The rendering code computes `tierSpacing = width / (maxTier + 2)` and places each node at `tierSpacing * (tier + 1)` on the X axis. Within each tier, nodes are vertically spaced by `height / (countInTier + 1)`. These are initial positions — the force simulation refines them during burn-in, but the tier structure establishes the fundamental left-to-right reading order.

After burn-in, section nodes have their X position pinned via `d.fx`, preserving the tier ordering. Interior nodes are snapped to their nearest section parent's X and then released to float, letting the link force pull them into natural vertical clusters around their parent's column rather than extending the horizontal chain.
