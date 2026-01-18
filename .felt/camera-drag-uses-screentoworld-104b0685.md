---
title: Camera drag uses screenToWorld projection for exact sieve behavior
status: closed
kind: decision
priority: 2
depends-on:
    - camera-perspectivecamera-at-45-7667ff37
created-at: 2026-01-18T13:57:32.839891+01:00
closed-at: 2026-01-18T13:57:40.060972+01:00
close-reason: Changed camera pan from approximated vectors (scale * dx/dy with trig functions) to actual screen-to-world projection. On mousedown, stores dragAnchor = screenToWorld(mouse). On mousemove, computes currentWorld = screenToWorld(mouse) and adjusts target by (dragAnchor - currentWorld). This keeps the world point under the mouse fixed throughout drag — true sieve behavior where the tile you click stays under your cursor.
---
