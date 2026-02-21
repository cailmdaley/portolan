---
title: RhizomeView links navigate in-view instead of opening new tabs
status: closed
kind: decision
priority: 2
depends-on:
    - absorb-claims-dashboard-into-ed04e0e9
created-at: 2026-02-09T11:05:25.199989+01:00
closed-at: 2026-02-10T20:29:50.874547+01:00
close-reason: 'Three link types unified under navigateToFiber(): (1) Dep-tags (upstream/downstream) — if rule fiber in DAG, selectNode(); else open in FileViewerModal. (2) Downstream items — same logic, replaced mini-detail popover. (3) Body markdown links — delegated click handler intercepts all <a> clicks. External URLs (http/https) open normally. Fiber ID patterns (.felt/xxx.md, slug-8hex) navigate in DAG or file viewer. All other relative paths open in file viewer via setOnOpenFile callback wired in main.ts.'
---
