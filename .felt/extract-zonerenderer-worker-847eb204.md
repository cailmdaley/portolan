---
title: Extract ZoneRenderer worker file tooltip controller
status: closed
tags:
    - task
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-10T20:04:12.029278+01:00
closed-at: 2026-03-10T20:07:03.263758+01:00
outcome: Extracted the worker recent-files tooltip subsystem from src/render/ZoneRenderer.ts into src/render/ZoneRendererWorkerTooltip.ts. ZoneRenderer now delegates tooltip hover, click routing, and runtime stats to the controller; the remaining major seams are label-drag state and city/worker render construction.
---

Extract the worker recent-files tooltip subsystem out of src/render/ZoneRenderer.ts so the renderer no longer owns tooltip DOM, hover timers, fetches, and click routing.
