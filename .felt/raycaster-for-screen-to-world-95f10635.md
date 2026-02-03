---
title: Raycaster for screen-to-world projection
status: closed
kind: decision
priority: 2
created-at: 2026-02-01T13:18:54.183232+01:00
closed-at: 2026-02-01T13:18:54.183235+01:00
close-reason: Manual trigonometry for screenToWorld was incorrect at certain zoom/position combinations. Replaced with Three.js Raycaster intersecting Y=0 plane - handles orthographic projection correctly regardless of camera angle.
---
