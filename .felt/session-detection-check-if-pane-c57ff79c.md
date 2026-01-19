---
title: 'Session detection: check if pane IS claude, not just children'
status: closed
kind: task
tags:
    - '[server]'
priority: 2
created-at: 2026-01-19T02:21:17.724756+01:00
closed-at: 2026-01-19T02:21:25.351318+01:00
close-reason: 'Fixed in both SessionTracker.ts and agent.js: When tmux runs ''zsh -l -c claude'', zsh execs into claude, making the pane process itself claude (not a child). Detection now checks ps -o comm= first, then falls back to pgrep -P for children. Sync comments added pointing each file to the other.'
---
