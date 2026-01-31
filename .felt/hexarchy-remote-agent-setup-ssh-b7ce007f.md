---
title: 'Hexarchy Remote Agent: setup, SSH tunnel, multi-node'
status: closed
kind: spec
tags:
    - '[docs]'
priority: 2
depends-on:
    - hexarchy-overview-spatial-map-40356835
created-at: 2026-01-25T15:26:42.456897+01:00
closed-at: 2026-01-31T00:56:51.421925+01:00
close-reason: Finalized documentation — referenced in CLAUDE.md Deep Dives.
---

The hexarchy-agent runs on remote machines and sends session data via SSH tunnel.

## Installation

```bash
./scripts/install-remote.sh candide          # Install
./scripts/install-remote.sh candide --start  # Install and start
```

Installs `hexarchy-hook.sh`, `agent.js`, patches Claude settings.

**Prerequisites on remote:** Node.js, jq, tmux, Claude Code

## SSH Tunnel (Required)

In local `~/.ssh/config`:
```
Host candide
    RemoteForward 4004 127.0.0.1:4004
```

If using ControlMaster, run `ssh -O exit <host>` to reset when adding new forwards.

## Manual Management

```bash
# On remote:
tmux new-session -d -s hexarchy-agent "node ~/bin/hexarchy-agent.js connect --ssh-host=candide"
tmux capture-pane -t hexarchy-agent -p  # Check status

# Update from local:
scp server/agent.js candide:~/bin/hexarchy-agent.js
```

## Multi-Node HPC

For clusters with multiple login nodes (like Leonardo):
- Agent constructs SSH alias: `cineca` + `login05` → `cineca-login05`
- SSH config maps to specific nodes
- Cities keyed by base sshHost so different nodes share cities

## Code Sync Notes

Keep in sync between `SessionTracker.ts` and `agent.js`:
- **Detection logic**: Check if pane process IS claude before checking children
- **Activity summary**: `extractSummary()` in `activityUtils.ts` is source of truth; copy in agent must match
- **Session name truncation**: Ralph sessions → `ralph-{hash}`, others → `first8…last8`
