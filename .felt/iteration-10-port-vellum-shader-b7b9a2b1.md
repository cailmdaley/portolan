---
title: 'Iteration 10: port vellum shader to Three.js'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T20:10:07.761067+01:00
closed-at: 2026-01-31T20:12:05.890266+01:00
close-reason: Ported vellum shader from Canvas 2D playground to Three.js ShaderMaterial. Created src/render/VellumShader.ts with simplex noise FBM for organic cloud variation, edge darkening, corner wear, and fine grain. Updated ZoneRenderer.ts to use createVellumPlane() instead of terrain.png texture. The photorealistic terrain is now replaced with authentic portolan-style warm cream vellum background. Verified rendering at localhost:5173 - shader compiles and displays correctly with hex grid overlay.
---
