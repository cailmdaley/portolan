---
title: Config value interpolation in RhizomeView fiber bodies
status: closed
kind: task
priority: 2
depends-on:
    - rhizome-endpoint-returns-full-2a1e18b5
    - batch-ssh-evidence-reads-to-bf8c0096
created-at: 2026-02-09T11:08:06.486257+01:00
closed-at: 2026-02-10T20:29:50.886389+01:00
close-reason: 'Server reads workflow/config/config.yaml (local or single SSH cat), parses with yaml package, flattens to dotted key paths (60 keys for pure_eb). Included in /rhizome response as ''config'' field. Client-side: interpolateConfig() walks <code> elements in p/td/li, strips config reference wrappers (config.x.y, config["x"]["y"], config.yaml: x.y), looks up resolved value, appends teal-colored '' = value'' span with full value on hover. Instantly shows actual parameter values inline next to their config key references.'
---
