---
title: Coastline angles follow hex edge normals (30°, 90°, 150°)
status: closed
kind: decision
priority: 2
depends-on:
    - terrain-background-tiled-10ef43ec
created-at: 2026-01-21T10:35:37.009914+01:00
closed-at: 2026-01-21T10:35:43.161464+01:00
close-reason: Pointy-top hex has 6 sides facing NE/NW/W/SW/SE/E. Coastlines run perpendicular to face direction. Sides 3,6 have vertical coastlines (90°), others at 30° or 150°. Documented in terrain-prompt.md.
---
