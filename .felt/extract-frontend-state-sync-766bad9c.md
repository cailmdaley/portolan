---
title: Extract frontend state sync from main.ts
status: closed
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-11T09:34:40.828105+01:00
closed-at: 2026-03-11T09:38:36.647127+01:00
outcome: Surveyed the remaining sub-800 production files and found that main.ts still mixed bootstrap with the full browser-server state sync runtime. Extracted WebSocket connection lifecycle, server-message routing, activity buffering, reconnect state, and runtime diagnostics accessors into src/runtime/FrontendStateSync.ts. main.ts dropped from 798 LOC to 521 LOC and now focuses on renderer/UI setup, map actions, initial camera focus, and lifecycle coordination. Verified with npm run build and cd server && npm test.
---
