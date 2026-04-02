---
title: Tunnel reset script
tags:
    - portolan
depends-on:
    - ssh-controlmaster-can-hold
    - gotcha-ssh-remoteforward-port
created-at: 2026-03-18T14:43:35.353008+01:00
outcome: Created scripts/reset-tunnel.sh — one-liner to fix stale SSH RemoteForward + stranded agent. Kills ControlMaster, re-establishes tunnel, verifies port 4004, restarts portolan-agent tmux session. Needed because resetting ControlMaster alone leaves the agent hung on a dead WebSocket — the agent doesn't recover without a restart.
---

(tunnel-reset-script)=
# Tunnel reset script
