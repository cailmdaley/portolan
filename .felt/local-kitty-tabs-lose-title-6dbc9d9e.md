---
title: Local kitty tabs lose title with bash -c; use tmux for stability
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T16:24:07.65877+01:00
closed-at: 2026-01-22T16:24:16.651843+01:00
close-reason: |-
    When launching kitty tab with 'bash -c "command"', the tab title gets overwritten by the running process name. The --title flag only sets initial title.

    Symptom: focus-tab --match title:X fails because tab no longer has that title.

    Fix: Use tmux even for local, same as remote pattern. tmux sessions have stable names, and kitty tab attached to tmux keeps its title.

    Pattern:
      tmux new-session -d -s <name> -c <cwd> 'zsh -l -c "command || exec zsh"'
      kitty @ launch --type=tab --title=<name> tmux attach -t <name>
---
