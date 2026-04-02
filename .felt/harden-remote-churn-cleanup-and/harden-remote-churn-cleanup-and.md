---
title: Harden remote churn cleanup and file viewer async race safety
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T13:56:46.676857+01:00
closed-at: 2026-03-01T14:00:27.638317+01:00
outcome: 'Closed two constitution gaps. (1) Server churn cleanup: added explicit remote-session teardown in handleAgentSessionsUpdate/handleAgentDisconnect so removed sessions now clear remoteLastActivity + remoteConversations, conditionally clear remoteActivities only when tmux is no longer active anywhere, persist activity-file deletions immediately, and prune stale remoteGitStatuses by active cwd per origin. This eliminates stale per-session map entries during partial remote churn, not just full-origin disconnect. (2) FileViewerModal race/lifecycle hardening: added owned request lifecycle with AbortController + request IDs so stale fetch completions cannot mutate current modal state across rapid open/navigate/refresh/hide, and added deterministic cleanup for deferred image-annotation outside-click listeners/timeouts. Evidence: npm run build (root) passed; cd server && npm test passed (239 tests); cd server && npm run build passed.'
---

(harden-remote-churn-cleanup-and)=
# Harden remote churn cleanup and file viewer async race safety
