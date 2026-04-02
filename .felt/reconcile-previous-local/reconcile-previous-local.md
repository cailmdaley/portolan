---
title: Reconcile previous local-session history ownership
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T17:36:48.910773+01:00
outcome: 'Eliminated stale local session retention in server state by introducing server/src/PreviousSessionReconciler.ts and wiring server/src/index.ts local session change handling through reconcilePreviousLocalSessions(...). Removed local-session-only drift in previousSessions by pruning missing local IDs before rebuild and re-seeding current local sessions, while preserving remote entries. Added server/src/__tests__/PreviousSessionReconciler.test.ts covering prune behavior, remote preservation, latest-object refresh, and custom local origin IDs. Evidence: cd server && npm test; cd server && npm run build; npm run build.'
---

(reconcile-previous-local)=
# Reconcile previous local-session history ownership
