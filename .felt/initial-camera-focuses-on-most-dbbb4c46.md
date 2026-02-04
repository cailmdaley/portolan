---
title: Initial camera focuses on most recent city
status: closed
kind: task
priority: 2
created-at: 2026-02-04T01:15:38.36473+01:00
closed-at: 2026-02-04T01:15:38.364734+01:00
close-reason: On page load/refresh, camera now focuses on city with most recent session activity (by lastActivity timestamp) at zoom level 6. Falls back to first city if no sessions. Fixed bug where lastActivity wasn't included in normalized Session type. Eliminates 'zoomed all the way out' on refresh.
---
