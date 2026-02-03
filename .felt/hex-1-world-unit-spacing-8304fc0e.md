---
title: Hex = 1 world unit spacing
status: closed
kind: decision
priority: 2
depends-on:
    - hex-grid-overlay-around-cities-008520c7
    - radius-based-city-click-f857ee1a
created-at: 2026-02-01T06:15:39.666232+01:00
closed-at: 2026-02-01T06:15:39.666236+01:00
close-reason: 'Set hexRadius = 1/sqrt(3) so adjacent hex centers are exactly 1 world unit apart. Makes spatial reasoning intuitive: ''3 hexes away'' = 3 world units. Previous hexRadius=1.0 gave spacing of ~1.73 units.'
---
