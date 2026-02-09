---
title: 'Gotcha: card header drag stopPropagation blocks bringToFront'
status: closed
kind: decision
priority: 2
created-at: 2026-02-07T00:48:10.736934+01:00
closed-at: 2026-02-07T00:48:10.736937+01:00
close-reason: 'startDrag on card header called e.stopPropagation(), preventing the card-level mousedown listener from firing onBringToFront. Fix: call onBringToFront() directly in startDrag before stopPropagation. Same pattern would apply to any handler that stops propagation on a child element.'
---
