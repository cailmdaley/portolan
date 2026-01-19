---
title: New workers launch with --dangerously-skip-permissions
status: closed
kind: decision
priority: 2
created-at: 2026-01-19T02:21:05.164862+01:00
closed-at: 2026-01-19T02:21:11.689594+01:00
close-reason: handleNewWorker and handleHandoff both add --dangerously-skip-permissions to claude invocation. Workers spawned from hexarchy UI run without permission prompts. This is intentional for workflow speed — user explicitly created the worker via the map interface.
---
