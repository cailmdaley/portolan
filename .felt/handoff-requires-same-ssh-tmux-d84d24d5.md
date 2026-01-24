---
title: Handoff requires same SSH+tmux pattern as newWorker for remote cities
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T16:23:21.516345+01:00
closed-at: 2026-01-22T16:23:31.381959+01:00
close-reason: |-
    KittyIntegration methods that work on cities must handle both local and remote.

    newWorker already had the pattern:
    - Remote: ssh -T to create tmux session, then kitty tab with ssh -tt to attach
    - Local: create tmux session, kitty tab attaches

    handoff was local-only — just ran 'kitty @ launch bash -c ...' which failed for remote cities (path doesn't exist locally).

    Fixed by mirroring newWorker pattern:
    - Lookup city by path to detect remote
    - Remote: SSH create tmux, kitty SSH attach
    - Local: Now also uses tmux (keeps title stable)

    Both use: felt on <fiberId> && claude --dangerously-skip-permissions || exec bash
---
