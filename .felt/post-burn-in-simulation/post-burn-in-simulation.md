---
title: 'Post-burn-in simulation stability: pin X, remove structural forces'
tags:
    - pattern
depends-on:
    - branch-separation-force-for
created-at: 2026-02-14T16:56:48.815946+01:00
outcome: 'Stable post-burn-in: X pinned via fx, structural forces nulled, alphaTarget reduced to 0.1 for drag, velocityDecay 0.9. No drift in either direction.'
---

(post-burn-in-simulation)=
After burn-in, the DAG constraint (target.x >= source.x + gap) causes rightward drift on every interaction because it only pushes right, never left. Removing it causes leftward collapse from link force. Solution: pin all node X positions via fx after burn-in. Remove branchSeparation, x-centering, y-centering forces. DAG constraint disabled in tick handler. Drag temporarily controls both fx/fy, re-pins X on release, Y free to settle.
