---
title: Kitty launch missing --cwd for session directory
status: closed
kind: task
priority: 2
depends-on:
    - fix-shell-escaping-in-kitty-d1bd3aac
created-at: 2026-01-18T02:57:28.507127+01:00
closed-at: 2026-01-18T02:57:28.507127+01:00
close-reason: 'Fixed in focusSession(): when launching new Kitty tab with ''kitty @ launch'', added --cwd=${escapedCwd} using session.cwd. Without this, terminals opened in wrong directory. tmux attach connects to existing session but the tab itself started in default directory.'
---
