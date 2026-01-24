---
title: 'Terrain images: top-down satellite view, not pre-angled'
status: closed
kind: decision
priority: 2
depends-on:
    - terrain-background-tiled-10ef43ec
created-at: 2026-01-21T10:35:20.537234+01:00
closed-at: 2026-01-21T10:35:28.668136+01:00
close-reason: Pre-angled images would double-project when viewed through 45° camera. Top-down images on flat plane + camera angle = correct single perspective transform.
---
