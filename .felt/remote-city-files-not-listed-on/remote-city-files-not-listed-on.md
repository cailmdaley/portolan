---
title: Remote city files not listed on startup - needs persistence
status: closed
created-at: 2026-01-25T17:50:27.379313+01:00
closed-at: 2026-01-25T18:16:31.731363+01:00
---

(remote-city-files-not-listed-on)=
## Problem
When opening pure_eb city, RECENTLY EDITED shows 'No recent files'. Remote files accessed in previous sessions aren't remembered.

## Expected
Previously accessed remote files should persist and show in RECENTLY EDITED on startup.

## Likely Fix
Persist recent files per-city to disk (similar to annotations.json). Load on city open.

## Files
- server/src/RecentFilesManager.ts - add persistence
- server/src/CityManager.ts - load on city init
