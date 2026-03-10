---
title: Coalesce activity-driven HUD updates and remove dead remote conversation map
status: closed
tags:
    - task
depends-on:
    - constitution-portolan-da3b0f59
created-at: 2026-03-01T16:51:33.600635+01:00
closed-at: 2026-03-01T16:53:47.834393+01:00
outcome: 'Implemented two hardening slices. (1) Frontend activity coalescing: src/main.ts now batches activity-driven HUD worker rerenders via requestAnimationFrame (scheduleWorkerHudUpdate) and owns/cancels that RAF in cleanupRuntime, preventing per-event full HUD rerenders during sustained activity bursts. (2) Server lifecycle/map cleanup: removed unused remote conversation map + HttpApi remote lookup fallback path, added explicit ownership for long-lived server intervals (fiber refresh + remote working timeout) with deterministic clearInterval on shutdown, and made shutdown idempotent with graceful server close. Evidence: npm run build passed; cd server && npm test passed (239 tests); cd server && npm run build passed.'
---
