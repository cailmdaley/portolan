---
title: 'Shell escaping: avoid nesting shellEscape, use double quotes for inner commands'
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T16:23:36.726616+01:00
closed-at: 2026-01-22T16:23:46.462833+01:00
close-reason: |-
    When building SSH commands that run tmux that runs bash -c, multiple layers of quoting are needed. Nesting shellEscape() calls creates quote soup that breaks.

    WRONG:
      const command = `felt on ${escapedFiberId} && claude`;
      const tmuxCmd = `tmux new-session ... 'bash -l -c ${shellEscape(command)}'`;
      const sshCmd = `ssh host ${shellEscape(tmuxCmd)}`;
    → Results in: '\''\''\'' nested escapes, bash syntax error

    RIGHT (match newWorker pattern):
      const tmuxCmd = `tmux new-session ... 'bash -l -c "felt on ${fiberId} && claude"'`;
      const sshCmd = `ssh -T host ${shellEscape(tmuxCmd)}`;
    → Inner command in double quotes, single shellEscape on outer tmux command

    fiberId is alphanumeric+dash, safe in double quotes.
---
