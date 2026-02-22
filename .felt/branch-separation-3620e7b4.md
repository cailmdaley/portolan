---
title: Branch separation
depends-on:
    - force-directed-layout-6d126304
created-at: 2026-02-21T19:27:09.602931+01:00
outcome: Custom D3 force pushes non-ancestral node pairs apart in Y. Uses NCA depth to scale strength — branches diverging early spread wider. Removed after burn-in so only link/charge/collide remain for interactive settling.
---

The branch separation force (`branchSeparationForce`) is a custom D3 force function registered as `simulation.force('branchSeparation', ...)`. It iterates over all node pairs and applies repulsive Y-velocity to nodes that are not in an ancestor-descendant relationship — i.e., nodes on independent branches of the DAG.

The force strength scales with branch distance from the nearest common ancestor (NCA). `ncaDepth()` computes the depth of the NCA for each pair using precomputed ancestor sets. The scaling formula `Math.min(branchDist, 3) / 3` ramps linearly from 0 at the split point to full strength at distance 3, meaning branches that diverge early feel the maximum separation while nodes near a shared parent stay close. The base strength constant `BRANCH_SEP_STRENGTH` is 3.0.

When nodes are closer than `BRANCH_MIN_Y_SEP` (2 * NODE_RY + 50 = 86px), the force applies both direct position nudges (30% of force) and velocity adjustments (20% of force). This dual approach prevents overlap more aggressively than velocity alone. Nodes further apart than 4x the minimum separation are skipped entirely, and pairs at very different X positions (more than 3 tiers apart) are also skipped as they cannot visually overlap.

After burn-in completes, this force is removed via `simulation.force('branchSeparation', null)`, along with the X and Y centering forces. Only the gentler link, charge, and collide forces remain for the interactive phase.
