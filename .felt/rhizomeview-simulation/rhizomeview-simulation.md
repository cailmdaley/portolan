---
title: RhizomeView simulation parameter tuning
tags:
    - decision
depends-on:
    - branch-separation-force-for
created-at: 2026-02-14T16:56:57.615668+01:00
outcome: Parameters produce well-separated branches with short edges. The distanceMax(400) on charge is key — prevents global repulsion from stretching edges across the graph.
---

(rhizomeview-simulation)=
Tuned force simulation for better branch separation and convergence. Changes from defaults: link distance 100→140, link strength floor Math.max(0.4, 1.5/maxDegree), charge -400→-500 with distanceMax(400), x-centering 0.03→0.015, y-centering 0.05→0.03, alphaDecay 0.02→0.012, velocityDecay 0.85→0.8, ticks 500→800.
