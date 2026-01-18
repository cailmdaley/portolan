---
title: 'Hex orientation: pointy-top with -π/2 offset matches axialToCartesian spacing'
status: closed
kind: decision
tags:
    - '[hexarchy-v2]'
priority: 2
depends-on:
    - visual-polish-wishlist-v1-f0a906d8
created-at: 2026-01-18T02:53:30.481473+01:00
closed-at: 2026-01-18T02:53:39.185599+01:00
close-reason: 'v2 had flat-top hex shapes (angle = π/3 * i) with pointy-top spacing formula (x = √3 * size * (q + r/2), z = 3/2 * size * r). This caused triangle gaps between hexes. Fix: add -π/2 to all angle calculations to make shapes pointy-top. Reference: Red Blob Games hex guide (redblobgames.com/grids/hexagons). Affected files: HexGrid.ts getHexCorners, ZoneRenderer.ts createHexShape and createRingShape.'
---
