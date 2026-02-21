---
title: 'Config interpolation: wrong path + unquoted bracket syntax'
status: closed
tags:
    - portolan,gotcha
created-at: 2026-02-19T23:41:04.962022+01:00
outcome: 'Two bugs prevented config[key] from resolving in fiber bodies for cmbx. (1) Server looked only at workflow/config/config.yaml but cmbx uses config/config.yaml at project root. Fixed by trying candidates in order: config/config.yaml first, then workflow/config/config.yaml. (2) Client key parser in interpolateConfig() stripped config["x"] (quoted) but not config[x] (unquoted). Fixed by making quote chars optional in the bracket regex. Both in HttpApi.ts and TapestryView.ts.'
---
