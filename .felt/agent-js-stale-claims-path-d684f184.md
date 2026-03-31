---
title: agent.js stale claims path
tags:
    - gotcha
depends-on:
    - evidence-path-rename-c415f931
created-at: 2026-03-18T21:54:03.749951+01:00
outcome: Remote agent detectClaims() was checking results/claims (old) instead of results/tapestry (new), and missing .felt/ entirely. CityManager.detectClaims was updated during the rename but agent.js was missed. Fixed and redeployed to candide. Also symlinked kinematic_lensing/results/tapestry → KineLens/results/tapestry since evidence lives in the nested project.
---
