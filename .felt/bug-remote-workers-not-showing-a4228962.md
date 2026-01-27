---
title: 'Bug: Remote workers not showing working status (teal)'
status: closed
kind: decision
priority: 2
depends-on:
    - worker-activity-panel-activity-86771906
created-at: 2026-01-27T03:06:49.831286+01:00
closed-at: 2026-01-27T03:06:49.831291+01:00
close-reason: |-
    Remote agent sends `agent_activity` events but server only stored them without updating session status. Local workers use EventWatcher to track status from events file, but remote events are on remote machine.

    **Fix:** Server now updates remote session status when receiving `agent_activity`:
    1. Added `remoteLastActivity` map to track timestamps (key: 'originId:tmuxSession')
    2. When activity received, set `session.status = 'working'` and update timestamp
    3. Added 5-second interval to check for 30-second timeout → set back to 'idle'
    4. Trigger `sessionTracker.notifyChange()` to broadcast status change

    Files modified: server/src/index.ts (lines 115-117, 983-994, 1088-1103)
---
