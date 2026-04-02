---
title: 'Iteration 1: restore vellum shader'
status: closed
depends-on:
    - city-sprites-nano-banana
created-at: 2026-02-01T01:50:27.555658+01:00
closed-at: 2026-02-01T01:51:43.236409+01:00
---

(iteration-1-restore-vellum)=
## Comments
**2026-02-01 02:00** — Extended scope: (1) Generated 5 default city sprites via nano-banana with magenta backgrounds, processed to transparent PNGs. (2) Created CitySpritesManager for sprite loading/caching. (3) Updated renderCity to use sprites instead of hex meshes. (4) Added createCityLabel for flat red text (no banners). (5) Removed old banner-based label code. Build passes.
**2026-02-01 02:05** — Fixed sprite orientation: changed from billboarded Sprite to flat Mesh with PlaneGeometry rotated -90° on X axis. City plans now lie flat on vellum like a printed map, correctly rendered at any camera angle.
