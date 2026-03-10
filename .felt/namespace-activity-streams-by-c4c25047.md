---
title: Namespace activity streams by origin-session key
status: closed
depends-on:
    - harden-remote-churn-cleanup-and-150f0c17
created-at: 2026-03-01T16:36:47.314966+01:00
closed-at: 2026-03-01T16:53:59.675008+01:00
outcome: 'Eliminated tmux-only activity ownership for remote workers by introducing a stable activitySessionKey (originId:tmuxSession) in server state broadcasts, live activity events, remote activity persistence, and frontend activity routing. Server now associates remote activity/cleanup with origin-scoped keys and prunes stale persisted entries during churn; frontend now stores/replays activity by stable session key and reapplies backfilled activity after zoneRenderer state update so decals cannot miss first render. Evidence: npm run build (root) passed; cd server && npm test passed (239 tests); cd server && npm run build passed.'
---
