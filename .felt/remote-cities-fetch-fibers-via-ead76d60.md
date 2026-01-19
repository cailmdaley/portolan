---
title: Remote cities fetch fibers via SSH + felt ls --json --body
status: closed
kind: task
tags:
    - '[server]'
priority: 2
depends-on:
    - session-detection-check-if-pane-c57ff79c
created-at: 2026-01-19T02:21:43.289347+01:00
closed-at: 2026-01-19T02:21:51.013274+01:00
close-reason: handleGetFibers checks city.originId — if not 'local', fetches fibers via SSH using 'felt ls -s open/closed --json --body'. Required adding --body flag to felt (implemented separately). getRemoteFibers() calls ssh {host} 'cd {path} && felt ls ...' and maps response to fiber format.
---
