---
title: 'Tapestry fog: visual treatment for collapsed-section nodes'
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
    - design-ghost-fog-over-display-415fa44f
    - pattern-visiblenodes-set-guards-43079193
created-at: 2026-02-21T23:01:03.942013+01:00
closed-at: 2026-02-21T23:09:34.718914+01:00
outcome: 'Final: fog nodes at opacity 0.09 with feGaussianBlur (stdDeviation 2). Ghost is subtle but present. Tried feTurbulence grain (see svg-feturbulence-grain-2f4354f8) — dropped because grain is invisible on light canvas at low opacity. Dot strips extended to all tiered nodes (not just sections), positioned text-relative. Section font 19px (was CSS-locked at 14px — see css-font-size-on-tapestry-node-a88893d0). Non-section nodes at 1.25x scale. Reveal animation: wave from nearest section ancestor, node opacity starts when incoming edge is 90% drawn (NODE_LAG=0.90). Bezier edges: drag-only inertia + compound spatial biases (see tapestry-edge-physics-drag-only-dc486ce6).'
---
