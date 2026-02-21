---
title: Config value interpolation in RhizomeView fiber bodies
status: closed
kind: task
priority: 2
depends-on:
    - rhizome-endpoint-returns-full-2a1e18b5
created-at: 2026-02-09T11:10:40.050954+01:00
closed-at: 2026-02-09T11:10:40.076482+01:00
close-reason: 'Server reads workflow/config/config.yaml (local or SSH), flattens to 60 dotted key paths. Client interpolateConfig() resolves backtick references (fiducial.version, config[x][y], config.yaml: x.y) and appends teal = value inline. Huge for verification — see actual parameter values next to their keys.'
---
