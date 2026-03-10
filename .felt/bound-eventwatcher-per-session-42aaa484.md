---
title: Bound EventWatcher per-session state and local churn cleanup
status: closed
depends-on:
    - constitution-portolan-da3b0f59
created-at: 2026-03-01T17:17:57.247654+01:00
closed-at: 2026-03-01T17:20:39.406177+01:00
outcome: 'Bounded EventWatcher per-session state ownership by adding explicit policy controls (max tracked sessions plus inactive retention), deterministic cleanup via reconcileActiveSessions for local tmux churn, and immediate idle-state removal from working-timeout ownership. Wired local session updates in server/src/index.ts to call eventWatcher.reconcileActiveSessions(...) so removed local sessions cannot retain cached activity/status data. Added server/src/__tests__/EventWatcher.test.ts covering idle cleanup, max-session eviction, active-session reconciliation, and retention pruning. Evidence: cd server && npm test; cd server && npm run build; npm run build.'
---
