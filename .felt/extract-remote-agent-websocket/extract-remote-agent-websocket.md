---
title: Extract remote agent websocket coordinator
status: closed
tags:
    - '[portolan]'
depends-on:
    - simplification-sweep
created-at: 2026-03-10T19:37:29.747834+01:00
closed-at: 2026-03-10T19:42:19.270092+01:00
outcome: Extracted remote agent session/activity ownership from server/src/index.ts into server/src/RemoteAgentCoordinator.ts. The new coordinator now owns remote session lifecycle, activity persistence and deduplication, git status bookkeeping, working-timeout expiry, and SSH tunnel reconnects, leaving the entrypoint at 741 LOC and focused on state assembly plus server wiring. Verified with cd server && npm test and npm run build.
---

(extract-remote-agent-websocket)=
Extract the remote agent session/activity state machine and agent WebSocket message handling out of server/src/index.ts so the entrypoint coordinates server wiring instead of owning remote session lifecycle logic.
