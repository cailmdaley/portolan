---
title: 'Tapestry edge physics: drag-only inertia via sagPos lerp'
status: closed
tags:
    - portolan
depends-on:
    - tapestry-force-simulation
created-at: 2026-02-22T01:56:23.404861+01:00
closed-at: 2026-02-22T07:01:08.31774+01:00
outcome: 'Spring-damper (sagPos/sagVel/sagInitialized) replaced with stateless approach. sagPos is the only state field. When node is dragged: sagPos += (targetSag - sagPos) * 0.12 (smooth inertial lag). When not dragging: sagPos = targetSag (immediate snap, zero motion). Additionally cp1 gets gravity bias (source.y/200 * dist * 0.10) and cp2 gets directional lean (sin/cos(baseAngle) * dist * 0.07) making each edge spatially unique based on position/direction.'
---

(tapestry-edge-physics-drag-only)=
# Tapestry edge physics: drag-only inertia via sagPos lerp
