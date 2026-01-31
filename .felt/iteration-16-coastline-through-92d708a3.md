---
title: 'Iteration 16: coastline-through-cities foundation'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T20:43:25.102979+01:00
closed-at: 2026-01-31T20:45:40.944949+01:00
close-reason: 'Implemented coastline-through-cities foundation. Changes: (1) Added CityPosition interface to CoastlineRenderer; (2) Implemented Catmull-Rom spline generation through city positions sorted by angle; (3) Modified ZoneRenderer to track city positions and regenerate coastline when they change; (4) Coastline now passes through all city hexes as ports, with organic variation between them. Next steps: city labels perpendicular to coast, remove hex meshes, worker ink figures.'
---
