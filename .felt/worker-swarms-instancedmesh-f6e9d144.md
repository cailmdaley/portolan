---
title: 'Worker swarms: InstancedMesh birds replacing Points particles'
status: closed
kind: decision
priority: 2
created-at: 2026-02-07T00:47:57.962745+01:00
closed-at: 2026-02-07T00:47:57.962749+01:00
close-reason: Switched from Points (screen-aligned quads, no per-particle rotation) to InstancedMesh with PlaneGeometry. Each bird is a tiny plane with bird.png texture, rotated per-frame to face velocity direction via atan2. 45 instances per swarm — negligible perf difference. Heading smoothed at 0.25 lerp per frame. BIRD_ANGLE_OFFSET = -π/4 corrects for bird PNG facing upper-left. renderOrder=9 fixes depth vs city sprites.
---
