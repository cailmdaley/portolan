---
title: Radius-based city click detection
status: closed
kind: decision
priority: 2
created-at: 2026-02-01T06:17:12.548022+01:00
closed-at: 2026-02-01T06:17:12.548027+01:00
close-reason: City sprites are larger than single hex, so added getCityAtWorldPos() that checks if click is within 3.25 world units of any city center. Falls back to hex-based lookup for workers. Applied to single-click, double-click, and context menu handlers.
---
