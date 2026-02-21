---
title: Burn-in phase
tags:
    - tapestry:portolan
depends-on:
    - tapestry-rendering-0a402a96
created-at: 2026-02-21T19:11:33.034828+01:00
outcome: 800 ticks of force simulation run before anything is drawn. After burn-in, structural forces are removed and section X positions are pinned, giving a stable left-to-right DAG.
---

The tapestry renders its DAG using a D3 force simulation that runs 800 ticks (`SIMULATION_TICKS`) silently before any SVG is drawn. During burn-in, five forces operate simultaneously: link attraction (distance 140px, strength inversely proportional to degree), charge repulsion (-500 strength, 400px max distance), collision avoidance (60px radius), a custom branch separation force, and gentle centering forces on both axes.

The branch separation force is the most distinctive. For every pair of nodes that don't share a direct ancestor-descendant relationship, it computes the nearest common ancestor (NCA) depth and pushes them apart in Y proportional to their branch distance from that NCA. This gives the DAG its characteristic fan shape — branches that diverge early spread widely, while nodes close to a shared ancestor stay near each other.

During each burn-in tick, a post-tick constraint ensures DAG ordering: if any edge's target has a smaller X than its source plus `minSeparation` (2 * NODE_RX + 60px), positions are nudged to maintain left-to-right flow. After all 800 ticks complete, the structural forces (branch separation, centering) are removed, `alphaDecay` increases to 0.05, and `velocityDecay` rises to 0.9. Section nodes get `fx` pinned; the simulation then runs gently for fine-tuning with only link, charge, and collide forces active.
