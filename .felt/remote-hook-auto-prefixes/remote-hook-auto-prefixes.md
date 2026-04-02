---
title: Remote hook auto-prefixes tmuxSession with originId
status: closed
depends-on:
    - gotcha-tmuxsession-prefix-for
created-at: 2026-02-11T17:28:53.782643+01:00
closed-at: 2026-02-11T17:28:53.782644+01:00
---

(remote-hook-auto-prefixes)=
Hooks on remote machines POST directly to :4004 via SSH tunnel. The HTTP handler stored tmuxSession unprefixed, but conversation lookup constructs originId/tmuxSession for remote sessions. Mismatch → empty conversation cards for all remote workers.
