---
title: 'Iteration 1: restore vellum shader'
status: closed
kind: task
priority: 2
depends-on:
    - city-sprites-nano-banana-21de7409
created-at: 2026-02-01T01:50:27.555658+01:00
closed-at: 2026-02-01T01:51:43.236409+01:00
close-reason: |-
    Major iteration accomplishing multiple spec items:

    1. **Vellum background**: Restored VellumShader.ts, integrated into ZoneRenderer.createGroundPlane()

    2. **Default city sprites**: Generated 5 via nano-banana (medieval, port, fortress, grid, river cities). Processed for transparency using magenta chroma-key. Stored in public/sprites/cities/

    3. **CitySpritesManager**: New class for sprite loading/caching with deterministic default selection by city ID hash

    4. **renderCity rewrite**: Uses flat Mesh (not billboard Sprite) so city plans lie correctly on vellum at any camera angle

    5. **City labels**: Flat red text (createCityLabel) replacing old banner-based labels

    6. **Camera angle exploration**: Tested pure top-down and 10° tilt, reverted to original 45° with flat sprite fix

    Build passes. Ready for visual testing.
---

## Comments
**2026-02-01 02:00** — Extended scope: (1) Generated 5 default city sprites via nano-banana with magenta backgrounds, processed to transparent PNGs. (2) Created CitySpritesManager for sprite loading/caching. (3) Updated renderCity to use sprites instead of hex meshes. (4) Added createCityLabel for flat red text (no banners). (5) Removed old banner-based label code. Build passes.
**2026-02-01 02:05** — Fixed sprite orientation: changed from billboarded Sprite to flat Mesh with PlaneGeometry rotated -90° on X axis. City plans now lie flat on vellum like a printed map, correctly rendered at any camera angle.
