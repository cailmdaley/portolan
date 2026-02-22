---
title: Navigation
status: open
tags:
    - tapestry:portolan
    - tier:1
depends-on:
    - tapestry-rendering-0a402a96
created-at: 2026-02-21T17:18:05.771969+01:00
outcome: 'The tapestry offers three zoom levels: the skeleton, the neighborhood, and the full detail. You move between them one click at a time, and every step is reversible.'
---

Hover over any node for 300ms to preview its content — title in bold, first paragraph, then the outcome. This is the scout: you're reading without committing. Click to commit: the node's immediate neighborhood emerges from the fog and the sidebar opens with full detail — body, outcome, evidence, artifacts. Click the same node again to collapse it back to fog. Click the canvas background to return to the skeleton.

The warp trace shows your path back: when you've navigated several hops into the interior, a gold thread appears connecting your selected node back through the DAG to its nearest section. This is the structural warp — the load-bearing thread that runs the length of the fabric. It orients you without forcing you back.

URL fragments make navigation shareable: clicking any node writes `#fiber-id` to the address bar. Share the URL and the recipient arrives at exactly that node. This tapestry is published as a static site — every fiber is directly linkable. Search (in the sidebar) filters all fibers, not just visible ones, and clicking a result reveals it from fog.
