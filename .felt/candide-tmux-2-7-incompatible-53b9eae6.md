---
title: Candide tmux 2.7 incompatible with allow-passthrough and terminal-features
status: closed
tags:
    - portolan,gotcha
created-at: 2026-02-20T21:02:56.259805+01:00
outcome: '~/.tmux.conf uses allow-passthrough and terminal-features which require tmux >= 3.3. Candide has 2.7. Fixed by wrapping both in if-shell version guards. Also: nvm node is not in PATH for non-interactive SSH sessions — must use full path /home/cdaley/.nvm/versions/node/v24.13.1/bin/node when running node via nohup over SSH.'
---
