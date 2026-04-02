---
title: Extract CityHUD directory browser
status: closed
tags:
    - portolan
depends-on:
    - simplification-sweep
created-at: 2026-03-11T03:35:39.696378+01:00
closed-at: 2026-03-11T03:38:16.045444+01:00
outcome: Extracted the CityHUD file-browser subsystem into src/ui/CityHUDFileTree.ts so directory cache state, websocket listDirectory requests, expansion/error/loading bookkeeping, and recursive tree rendering no longer live inside the HUD shell. CityHUD.ts dropped from 896 LOC to 721 LOC and now coordinates tabs, search, fibers, worker chips, and modal visibility while delegating file browsing to the new controller. Verified with npm run build and cd server && npm test.
---

(extract-cityhud-directory)=
Extract the directory listing state, websocket requests, expansion cache, and tree rendering out of src/ui/CityHUD.ts so the HUD shell coordinates tabs/search/workers instead of owning the file-browser subsystem.
