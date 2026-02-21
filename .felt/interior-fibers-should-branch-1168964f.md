---
title: Interior fibers should branch vertically not horizontally
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
    - skeleton-view-rendering-2e55e587
created-at: 2026-02-21T18:50:41.071727+01:00
closed-at: 2026-02-21T19:14:46.220227+01:00
outcome: 'Implemented: only section nodes (tier:1) have fx pinned after burn-in. Interior nodes have their x snapped to nearest section parent''s x, then fx left undefined. Link force pulls them toward the pinned section column; charge force spreads them in Y. updateTierVisibility() now also restarts simulation at alpha(0.05) so newly visible nodes can settle when section expands. Commit: 78847ef.'
---
