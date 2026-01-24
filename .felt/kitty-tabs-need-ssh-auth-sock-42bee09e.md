---
title: Kitty tabs need SSH_AUTH_SOCK for agent auth
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T15:28:31.137488+01:00
closed-at: 2026-01-22T15:28:41.625523+01:00
close-reason: "Kitty tabs launched via `kitty @` don't inherit SSH_AUTH_SOCK from the environment. SSH commands fail with 'Permission denied' even when agent has valid keys/certificates.\n\n**Symptom:** Tab flashes and closes. With `--hold`: 'no such identity', 'Permission denied'.\n\n**Fix:** Pass SSH_AUTH_SOCK explicitly when launching tabs:\n```typescript\nconst sshAuthSock = process.env.SSH_AUTH_SOCK \n  ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` \n  : '';\nconst kittyCmd = `kitty @ launch --type=tab ${sshAuthSock} ...`;\n```\n\n**Requirement:** Server process must have SSH_AUTH_SOCK in its environment. If running via tsx/npm, ensure terminal has agent loaded.\n\n**Related:** Step SSH certificates (`step ssh login`) add time-limited certs to agent. Without agent passthrough, these certs are invisible to Kitty tabs."
---
