---
title: CSS2D labels for OpenType typography (smcp, pcap)
status: closed
kind: decision
priority: 2
depends-on:
    - local-eb-garamond-with-opentype-40d35a7d
created-at: 2026-02-01T06:15:34.093912+01:00
closed-at: 2026-02-01T06:15:34.093916+01:00
close-reason: 'Switched from canvas-based labels to Three.js CSS2DRenderer with HTML overlays. Canvas doesn''t support font-feature-settings, but HTML does. Enables proper small caps for cities, petite caps for workers. Trade-off: need pointer-events management, DOM cleanup on removal. Well-trodden path — Three.js ships CSS2DRenderer specifically for this.'
---
