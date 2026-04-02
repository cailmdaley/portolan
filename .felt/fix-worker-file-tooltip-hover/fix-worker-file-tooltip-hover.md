---
title: Fix worker file tooltip hover-state cleanup
status: closed
tags:
    - portolan
depends-on:
    - coastline-file-touch-hover
created-at: 2026-03-02T04:32:12.843736+01:00
closed-at: 2026-03-02T04:32:16.658593+01:00
outcome: 'Patched ZoneRenderer tooltip state machine: hideWorkerFileTooltip() now clears hover timers and resets workerFileTooltipHovered, preventing stale-hover state from suppressing mouseout dismissal after click/hide flows. updateState() now hides tooltip immediately when the currently targeted worker disappears from active sessions, avoiding stale tooltip UI for removed workers. Verification: npm run build (pass); server file-touch tests remain passing (npm test -- HttpApi.file-touch.test.ts).'
---

(fix-worker-file-tooltip-hover)=
Ensure hover tooltip dismissal remains reliable by resetting internal hover state on programmatic hide and by auto-hiding tooltip state when the hovered worker disappears from server state updates.
