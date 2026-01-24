---
title: Multi-node HPC SSH architecture for hexarchy
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T15:28:11.808948+01:00
closed-at: 2026-01-22T15:28:24.766909+01:00
close-reason: |-
    Pattern for connecting hexarchy to multi-node HPC systems (like cineca Leonardo with login01/02/05/07):

    **Problem:** Load-balanced SSH endpoint (login.leonardo.cineca.it) routes to random login node. Each node has separate tmux server. Session on login05 invisible from login07.

    **Solution stack:**
    1. **RemoteForward 4004** in SSH config tunnels agent→server connection
    2. **Agent constructs specific SSH alias** from hostname: `cineca` + `login05` → `cineca-login05`
    3. **SSH config maps aliases** to specific nodes: `cineca-login05` → `login05-ext.leonardo.cineca.it`
    4. **City keys normalized** by base sshHost so different nodes share cities: `remote-cineca:/path`
    5. **City originId updates** when accessed from different node (keeps UI consistent)

    **SSH config pattern:**
    ```
    Host cineca cineca*
      HostName login.leonardo.cineca.it
      RemoteForward 4004 127.0.0.1:4004
      ServerAliveInterval 30

    Host cineca-login05
      HostName login05-ext.leonardo.cineca.it
    ```

    **Agent code:** `buildSpecificSshHost()` extracts node from hostname, constructs alias.
    **Server code:** `CityManager.setOriginSshHost()` normalizes city keys by base sshHost.
---
