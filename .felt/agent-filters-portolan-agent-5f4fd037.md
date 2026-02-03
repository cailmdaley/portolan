---
title: Agent filters portolan-agent session
status: closed
kind: decision
priority: 2
depends-on:
    - hexarchy-remote-agent-setup-ssh-b7ce007f
created-at: 2026-02-01T14:14:40.865904+01:00
closed-at: 2026-02-01T14:14:40.865908+01:00
close-reason: 'Reopened: pgrep -f was matching ~/.claude/ paths in command lines. Changed to pgrep -x for exact process name matching in SessionTracker.ts, TranscriptReader.ts, and agent.js (4 locations).'
---
