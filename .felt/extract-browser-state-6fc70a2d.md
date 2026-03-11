---
title: Extract browser state coordinator from server entrypoint
status: closed
tags:
    - task
    - portolan
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-11T17:26:06.899968+01:00
closed-at: 2026-03-11T17:26:15.085543+01:00
outcome: Surveyed the remaining sub-800 production files and found that server/src/index.ts still mixed entrypoint wiring with browser-state assembly, local-session reconciliation, fiber polling, and city/fiber websocket mutations. Extracted that runtime into server/src/BrowserStateCoordinator.ts, including state building, browser client tracking, local-session reconciliation, fiber refresh polling, remote/local fiber reads, and city pin/unpin/move handlers. server/src/index.ts dropped from 741 LOC to 383 LOC and now focuses on manager setup, HTTP/WebSocket wiring, agent message routing, and lifecycle startup/shutdown. Verified with cd server && npm test and npm run build.
---
