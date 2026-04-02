---
title: Extract CityHUD search runtime
status: closed
tags:
    - portolan
depends-on:
    - simplification-sweep
created-at: 2026-03-11T22:12:31.305938+01:00
outcome: Extracted CityHUD search input state, websocket search dispatch, local fiber filtering, and search-result click handling into `src/ui/CityHUDSearch.ts`; `CityHUDContent.ts` now focuses on fiber loading/rendering and handoff/open-file coordination. Verified with `npm run build` and `cd server && npm test`.
---

(extract-cityhud-search-runtime)=
# Extract CityHUD search runtime
