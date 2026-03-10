---
title: Extract HttpApi tapestry endpoints
status: closed
tags:
    - '[portolan]'
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-10T20:37:45.388379+01:00
closed-at: 2026-03-11T00:45:21.180847+01:00
outcome: Extracted the tapestry DAG and asset-serving subsystem from server/src/HttpApi.ts into server/src/HttpApiTapestry.ts. HttpApi.ts now routes those endpoints into the dedicated controller and dropped to 682 LOC; verified with cd server && npm test and npm run build.
---

Extract the tapestry DAG and asset-serving subsystem out of server/src/HttpApi.ts so the file no longer mixes route dispatch with tapestry-specific data assembly.
