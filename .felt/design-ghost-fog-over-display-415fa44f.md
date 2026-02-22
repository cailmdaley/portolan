---
title: 'Design: ghost fog over display:none for collapsed tapestry nodes'
status: closed
tags:
    - portolan
created-at: 2026-02-21T23:09:58.618853+01:00
outcome: 'Fog nodes (not in current expanded set) render at opacity 0.07 with SVG feGaussianBlur filter (stdDeviation 2), pointer-events none. This gives structural presence without legibility — reader senses the graph exists beyond what''s visible. display:none alternative was worse: no sense of depth. Ghost edges at 0.04 opacity extend this to edges — full skeleton subtly present.'
---
