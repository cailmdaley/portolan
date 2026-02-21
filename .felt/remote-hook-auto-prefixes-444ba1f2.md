---
title: Remote hook auto-prefixes tmuxSession with originId
status: closed
kind: decision
priority: 2
depends-on:
    - gotcha-tmuxsession-prefix-for-a32058c7
created-at: 2026-02-11T17:28:53.782643+01:00
closed-at: 2026-02-11T17:28:53.782644+01:00
close-reason: handleHookMessage now auto-detects remote sessions by matching the incoming tmuxSession against known remote sessions in SessionTracker. If a match is found, it prefixes with originId/ before storing in ConversationCache. This means PORTOLAN_URL config on remotes is unnecessary — hooks can always POST to localhost:4004 via tunnel and the server handles prefixing. The agent WebSocket path (port 4005) already prefixed, so no double-prefix risk — prefixed names don't match any session's raw tmuxSession.
---

Hooks on remote machines POST directly to :4004 via SSH tunnel. The HTTP handler stored tmuxSession unprefixed, but conversation lookup constructs originId/tmuxSession for remote sessions. Mismatch → empty conversation cards for all remote workers.
