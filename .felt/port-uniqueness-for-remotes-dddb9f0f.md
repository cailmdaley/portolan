---
title: 'Port uniqueness for remotes: base + hostname hash pattern'
status: closed
kind: spec
priority: 2
created-at: 2026-01-19T09:15:25.711718+01:00
closed-at: 2026-01-19T09:15:34.094001+01:00
close-reason: 'For tools running on multiple machines accessed via SSH LocalForward, use deterministic port = BASE + (hostname | cksum | cut -d'' '' -f1) % 100. This gives each machine a unique, stable port. Examples: PLOT_PORT=8800+hash, PLANNOTATOR_PORT=19400+hash. Defined in ~/loom/shell-functions.sh. SSH config uses LocalForward to map remote port to local.'
---
