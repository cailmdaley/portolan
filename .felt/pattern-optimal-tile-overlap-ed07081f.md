---
title: 'Pattern: optimal tile overlap via MSE minimization'
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T11:53:56.725522+01:00
closed-at: 2026-01-22T11:54:10.2018+01:00
close-reason: 'For seamless tile blending: scan overlap amounts (e.g., 2040-2060px), compute MSE between right-edge of tile A and left-edge of tile B at each overlap. Minimum MSE = optimal alignment. For outpainted tiles, optimal is ~half the tile (2048px). 2D search adds vertical offset parameter - improves alignment 30-40%. Then gradient blend over the overlap region: output = A*(1-gradient) + B*gradient.'
---
