---
title: 'Gotcha: SSH double-quote shell expansion kills remote processes'
status: closed
tags:
    - portolan,gotcha
depends-on:
    - gotcha-ssh-double-quote
created-at: 2026-02-20T21:02:50.929212+01:00
outcome: 'ssh candide "kill $(pgrep ...)" expands $() LOCALLY before sending over SSH. The local PIDs get sent to kill on the remote, matching arbitrary processes. This killed candide''s tmux server. Fix: always use single quotes for remote commands containing shell expansions, or use heredocs. ssh candide ''kill $(pgrep ...)'' evaluates pgrep on the remote.'
---

(gotcha-ssh-double-quote-shell)=
# Gotcha: SSH double-quote shell expansion kills remote processes
