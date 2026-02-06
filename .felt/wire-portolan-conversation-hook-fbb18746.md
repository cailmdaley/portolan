---
title: Wire portolan-conversation-hook.sh into setup.sh
status: closed
kind: task
priority: 2
created-at: 2026-02-06T17:25:11.624214+01:00
closed-at: 2026-02-06T17:25:11.62422+01:00
close-reason: setup.sh now registers portolan-conversation-hook.sh for UserPromptSubmit, PostToolUse, and Stop alongside the existing portolan-hook.sh (activity tracking). No PORTOLAN_URL env var needed — SSH RemoteForward 4004 makes localhost:4004 work on all remotes. Running setup.sh on any machine configures everything.
---
