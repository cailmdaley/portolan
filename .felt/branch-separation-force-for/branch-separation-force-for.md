---
title: Branch separation force for RhizomeView DAG
tags:
    - decision
created-at: 2026-02-14T16:56:36.362765+01:00
outcome: 'Custom branchSeparationForce added to simulation. Removed after burn-in so interactive dragging doesn''t cause layout drift. Parameters: BRANCH_SEP_STRENGTH=3.0, BRANCH_MIN_Y_SEP=2*NODE_RY+50.'
---

(branch-separation-force-for)=
Independent branches flowing into the same node were overlapping visually. Added a custom d3 force that computes ancestor sets for every node, finds nearest common ancestor depth for pairs, and pushes apart nodes in Y proportional to their distance from the branching point. Strength ramps from 0 at the split to full at branch distance 3. Uses direct position nudges (60%) plus velocity (40%) for structural effect during burn-in.
