---
title: 'Bug: SSH escaping for remote tmux commands with spaces'
status: closed
kind: decision
priority: 2
created-at: 2026-01-27T03:06:39.467837+01:00
closed-at: 2026-01-27T03:06:39.467845+01:00
close-reason: |-
    Remote killWorker failed for sessions with spaces (e.g., 'felt find'). The command `ssh host tmux kill-session -t 'felt find'` fails because local shell strips quotes before SSH receives it.

    **Fix:** Double-escape by wrapping entire remote command in shellEscape():
    ```typescript
    const remoteTmuxCmd = `tmux kill-session -t ${escapedSession}`;
    const sshCmd = `ssh ${origin.sshHost} ${shellEscape(remoteTmuxCmd)}`;
    ```

    This matches the pattern already used in createWorker (lines 207-208). The outer shellEscape causes local shell to pass the entire command intact to SSH, which then passes it to remote shell where inner quotes work correctly.

    File: server/src/KittyIntegration.ts:469-470
---
