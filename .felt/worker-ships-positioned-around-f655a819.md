---
title: 'Worker ships: positioned around southern arc of cities'
status: closed
kind: task
priority: 2
depends-on:
    - ship-sprite-bold-black-linework-86becbd7
created-at: 2026-02-01T14:03:33.020843+01:00
closed-at: 2026-02-01T14:03:33.020847+01:00
close-reason: 'Workers now render as ship sprites positioned in arc (45° to 135°) around the front/south side of cities. Ships are 2.0 world units, radius 3.0 from city center. Labels below ships at y=-0.8. Ships clickable: single-click opens worker panel, double-click focuses terminal. Files: ShipSpritesManager.ts (new), ZoneRenderer.ts (ship positioning + click detection), main.ts (click handlers).'
---
