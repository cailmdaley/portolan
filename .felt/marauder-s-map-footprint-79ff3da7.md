---
title: Marauder's Map footprint sprites with steering behavior
status: closed
kind: task
priority: 2
depends-on:
    - pattern-steering-behavior-vs-cc10306b
    - pattern-nano-banana-4128a488
created-at: 2026-01-31T23:26:07.699063+01:00
closed-at: 2026-01-31T23:26:07.699082+01:00
close-reason: 'Implemented ink-style footprint trails for workers. Key changes: (1) Generated sepia ink footprint sprites via nano-banana, extracted transparency with ImageMagick fuzz-based white removal (difference matting failed because Gemini changes asset when editing background). (2) Replaced force-based wandering with heading-based steering - workers have a heading angle that changes gradually (max 45°/sec), creating smooth curves instead of u-turns. (3) Left/right feet offset perpendicular to walking direction. (4) Footprints use heading for rotation (not noisy velocity). (5) When worker stops, last 2 footprints remain as standing position. Sprites at public/sprites/footprint-{left,right}.png.'
---
