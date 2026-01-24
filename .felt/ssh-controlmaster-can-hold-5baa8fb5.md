---
title: SSH ControlMaster can hold stale tunnels; ssh -O exit to reset
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T16:24:22.89535+01:00
closed-at: 2026-01-22T16:24:33.159231+01:00
close-reason: |-
    With ControlMaster auto + ControlPersist, SSH connections are reused for the persist duration (e.g., 30m). If the original connection was made before a RemoteForward was added to config, or if the tunnel broke mid-session, the persisted connection won't have the tunnel.

    Symptom: hexarchy-agent in reconnect loop, can't reach localhost:4004 on remote, even though config has RemoteForward 4004.

    Diagnosis: ssh host 'ss -tln | grep 4004' — if not listening, tunnel is broken.

    Fix: ssh -O exit <host> — kills control socket. Next connection starts fresh with all forwards from config.

    CLAUDE.md already mentions this for adding new forwards; reinforced here as common failure mode.
---
