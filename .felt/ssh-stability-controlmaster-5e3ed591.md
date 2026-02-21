---
title: 'SSH stability: ControlMaster + RequestTTY fixes for cineca/candide remotes'
tags:
    - portolan
created-at: 2026-02-15T15:57:24.916568+01:00
outcome: 'Cineca remote was flaky: agent disconnecting repeatedly, fiber reads failing with doubled hostname (cineca-login07-login07). Root causes: (1) buildSpecificSshHost in agent.js wasn''t idempotent — if launched with --ssh-host=cineca-login07 (already specific), it appended -login07 again. Fixed with endsWith guard. (2) No ControlMaster on cineca SSH config — every portolan SSH command opened a new connection, and the RemoteForward tunnel died between agent reconnects. Added ControlMaster auto + ControlPersist 30m. (3) RequestTTY yes caused pseudo-terminal warnings on all non-interactive SSH commands. Changed to RequestTTY no on both cineca and candide — interactive sessions still get TTY from OpenSSH defaults. (4) Corrupt cities.json entry had the doubled sshHost baked in. Fixed manually. Agent restarted with --ssh-host=cineca (base name) so buildSpecificSshHost constructs cineca-login07 correctly.'
---


## Comments
**2026-02-15 16:46** — RequestTTY no broke interactive terminal sessions (no PS1, no completion) when ControlMaster was active — the master's no-TTY setting propagated to all multiplexed sessions. Changed to RequestTTY auto on both cineca and candide. auto = PTY for interactive, no PTY for command-mode. Best of both worlds.

