---
title: Use exact tmux session targets
status: closed
created-at: 2026-03-15T14:19:41.455656+01:00
closed-at: 2026-03-15T14:21:38.10956+01:00
outcome: 'Portolan now uses exact tmux targets (=session) everywhere worker sessions are checked or targeted: creation checks, attach/focus, kill, handoff paste/send-keys, annotation paste, and remote agent activation checks. Added an exactTmuxTarget helper to avoid ad hoc string building. Verified with npm run build and targeted server tests for KittySessionController, SessionTracker, and HttpApi file-content.'
---

(use-exact-tmux-session-targets)=
# Use exact tmux session targets
