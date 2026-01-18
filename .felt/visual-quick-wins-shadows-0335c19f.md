---
title: 'Visual quick wins: shadows, random elevation, hex edge lines'
status: closed
kind: spec
tags:
    - '[hexarchy-v2]'
priority: 2
depends-on:
    - visual-polish-wishlist-v1-f0a906d8
created-at: 2026-01-18T02:53:57.840806+01:00
closed-at: 2026-01-18T02:54:05.017274+01:00
close-reason: '~40 LOC for significant visual improvement: (1) Enable renderer.shadowMap + directionalLight.castShadow with shadow camera bounds, (2) Random elevation per empty hex (Math.random() * 0.04) for terrain feel, (3) LineLoop hex edges in umber at 30% opacity for definition, (4) Ground plane receives shadows. These get 80% of the Civ feel without full v1 port or threejs-hex-map complexity.'
---
