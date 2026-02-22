---
title: 'Warp trace: textile breadcrumb replacing navigation spine'
tags:
    - portolan
    - decision
depends-on:
    - tapestry-metaphor-resolution-b80dc7fa
created-at: 2026-02-21T21:53:18.148644+01:00
outcome: 'Replaced ''breadcrumb spine'' with ''warp trace'' — the structural thread in weaving that runs the length of the fabric. In the tapestry, the warp trace is a highlighted gold (#9A7B35) path from any selected node back to its nearest section (tier:1) node via BFS. Computed by computeWarpTrace() returning {nodes: Set<string>, edges: Set<string>}. The textile vocabulary matters: sections are warp threads (structural), internal fibers are weft (cross-threads that create the pattern).'
---
