---
title: Add runtime performance and memory diagnostics surface
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T17:22:42.448988+01:00
closed-at: 2026-03-01T17:26:31.472331+01:00
outcome: 'Added durable runtime observability surface centered on /debug-runtime. server/src/HttpApi.ts now supports setRuntimeDiagnosticsProvider and serves GET /debug-runtime with timestamp/pid/uptime/memory plus provider payload. server/src/index.ts wires provider ownership for long-lived server state (session counts, websocket clients/origins, map cardinalities, interval liveness, eventWatcher stats, remote working tracker stats, conversation cache counts). Added explicit stats accessors in server/src/EventWatcher.ts (getStats) and server/src/RemoteWorkingSessionTracker.ts (getStats). Added regression coverage in server/src/__tests__/HttpApi.runtime.test.ts, plus stats tests in EventWatcher.test.ts and RemoteWorkingSessionTracker.test.ts. Evidence: cd server && npm test (253 tests); cd server && npm run build; npm run build.'
---

(add-runtime-performance-and)=
Implement durable runtime diagnostics for frontend and server: listener counts, cache stats, activity stream cardinality, and deterministic teardown visibility for repeated stress loops.
