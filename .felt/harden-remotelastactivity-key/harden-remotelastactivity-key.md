---
title: Harden remoteLastActivity key ownership and timeout cleanup
status: closed
tags:
    - spec
depends-on:
    - constitution-portolan
created-at: 2026-03-01T17:00:06.165095+01:00
closed-at: 2026-03-01T17:03:31.208123+01:00
outcome: 'Introduced RemoteWorkingSessionTracker to own remote working-timeout state by explicit origin/session keys (no delimiter parsing), wired index.ts to reconcile tracker state from agent session updates, activity events, and disconnect cleanup, and switched timeout expiry to tracker.consumeExpired(). Added unit coverage for status transitions, expiration semantics, origin-wide cleanup, and tmux names containing colons. Verified with: cd server && npm test && npm run build.'
---

(harden-remotelastactivity-key)=
Refactor remote per-session activity timeout ownership to avoid delimiter parsing bugs and ensure deterministic cleanup under remote churn. Includes key helper updates and regression coverage.
