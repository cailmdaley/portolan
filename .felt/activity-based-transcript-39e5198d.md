---
title: Activity-based transcript mapping
status: closed
kind: decision
priority: 2
depends-on:
    - session-transcript-mapping-via-3a6ebe65
created-at: 2026-02-01T23:11:44.662452+01:00
closed-at: 2026-02-01T23:11:44.662456+01:00
close-reason: Session→transcript mappings were going stale when user started new Claude sessions in same tmux window. Activity events include sessionId (Claude transcript UUID) — now use this directly to construct transcript path when activity arrives. More reliable than lsof detection which only works while Claude is running.
---
