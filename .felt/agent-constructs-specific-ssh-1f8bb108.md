---
title: Agent constructs specific SSH node alias
status: closed
kind: decision
priority: 2
depends-on:
    - multi-node-hpc-ssh-architecture-c409447d
created-at: 2026-01-22T15:29:06.880053+01:00
closed-at: 2026-01-22T15:29:16.534637+01:00
close-reason: |-
    **Question:** Where should multi-node SSH alias construction live — agent or server?

    **Decision:** Agent constructs specific alias. Server just uses what agent provides.

    **Reasoning:**
    - Agent knows its hostname (`login05.leonardo.local`)
    - Agent knows base sshHost from `--ssh-host` flag (`cineca`)
    - Construction is simple: `{sshHost}-{nodeMatch[1]}`
    - Keeps server code generic (no HPC-specific patterns)
    - User's SSH config stays human-readable (`cineca-login05`)

    **Implementation:** `buildSpecificSshHost(baseSshHost)` in agent.js:
    ```javascript
    const nodeMatch = ORIGIN_NAME.match(/^(login\d+)\./);
    if (nodeMatch) return `${baseSshHost}-${nodeMatch[1]}`;
    return baseSshHost;
    ```

    **Alternative rejected:** Server-side pattern matching — would hard-code HPC patterns, less flexible.
---
