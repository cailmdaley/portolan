---
title: Fix shell escaping in Kitty focus commands
status: closed
kind: task
tags:
    - ralph:3
priority: 2
depends-on:
    - server-14a1cdf1
created-at: 2026-01-18T00:42:21.008139+01:00
closed-at: 2026-01-18T00:43:17.526524+01:00
close-reason: Fixed shell escaping in Kitty focus commands. Added shellEscape() helper that wraps arguments in single quotes and properly escapes embedded quotes using the '\'' pattern. Applied to tmux session names in both focus-tab and launch commands (lines 292, 300). Verified build passes. Handles spaces, special characters ($, parens), and quotes correctly.
---
