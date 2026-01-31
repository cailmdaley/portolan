---
title: 'Iteration 18: remove hex meshes, port-style city markers'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T20:51:16.145013+01:00
closed-at: 2026-01-31T20:54:53.647788+01:00
close-reason: 'Removed 3D hex extrusions for cities, replaced with port-style markers. Changes: (1) Cities now render as circular markers (gold active, brown dormant) with dark ink outline; (2) City labels in bright manuscript red (#A0171B), positioned perpendicular to coastline using getCoastlineAngleAt(); (3) Labels positioned 0.8 units inland from marker; (4) Removed unused SpriteMaterial, labelSprite, baseScale, cityBannerImage code; (5) Simplified animate() method. Workers still use hex blocks - Marauder''s Map ink figures planned for future iteration.'
---
