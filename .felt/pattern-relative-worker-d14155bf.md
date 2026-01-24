---
title: 'Pattern: relative worker positions with absolute calculation in buildState'
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T16:39:17.40955+01:00
closed-at: 2026-01-22T16:39:23.74544+01:00
close-reason: |-
    Worker hex positions are stored relative to city center (0,0). buildState() calculates absolute positions on every broadcast:

    workerHex: {
      q: city.position.q + session.workerHex.q,
      r: city.position.r + session.workerHex.r,
    }

    **Benefit:** When city moves, workers automatically follow — no worker position updates needed. The offset calculation handles it.

    **Contrast:** If workers stored absolute positions, moving a city would require iterating all workers and updating their positions.

    This pattern enables clean city movement without touching worker state.
---
