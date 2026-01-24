---
title: City deduplication across HPC login nodes
status: closed
kind: decision
priority: 2
depends-on:
    - multi-node-hpc-ssh-architecture-c409447d
created-at: 2026-01-22T15:28:49.486912+01:00
closed-at: 2026-01-22T15:29:00.783556+01:00
close-reason: |-
    **Problem:** Same path on shared HPC storage created duplicate cities when accessed from different login nodes. Each node reported different originId (remote-login05 vs remote-login07).

    **Decision:** Normalize city keys by base sshHost, not full originId.

    **Implementation:**
    - `CityManager.setOriginSshHost(originId, sshHost)` extracts base: `cineca-login05` → `cineca`
    - `makeKey()` returns `remote-{baseSshHost}:{path}` for remote origins
    - City's `originId` updates when accessed from different node (UI consistency)
    - Called on agent connect AND when loading persisted cities

    **Key insight:** sshHost comes from agent (which knows its specific node). Base sshHost extracted by stripping `-login\d+` suffix.

    **Alternative considered:** Dedupe purely by path — rejected because local vs remote paths could collide.
---
