---
title: readFileSync replaced with readFile in async HttpApi handlers
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T03:00:57.381408+01:00
closed-at: 2026-02-09T03:00:57.381416+01:00
close-reason: Two places in HttpApi.ts (rhizome asset serving and playground serving) used dynamic import of fs.readFileSync inside async functions. Replaced with the already-imported readFile from fs/promises for consistency and to avoid blocking the event loop.
---
