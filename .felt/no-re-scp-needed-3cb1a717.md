---
title: No re-scp needed
status: closed
depends-on:
    - implement-nested-symlink-86ab60d8
    - search-tools-fd-rg-with-find-ee13e331
created-at: 2026-03-02T23:18:37.28+01:00
closed-at: 2026-03-02T23:18:52.681104+01:00
outcome: Remote search execution lives in server/src/index.ts and runs from the local Portolan server over SSH (searchLocal/searchRemote). Remote agents are not in the file-search execution path. Applying this search fix requires restarting/updating the local server process, not re-scping remote agent code.
---
