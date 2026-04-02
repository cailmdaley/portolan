---
title: Migration rewrites pre-existing deps
tags:
    - felt
    - gotcha
depends-on:
    - portolan-daily-driver-migration
created-at: 2026-04-01T23:51:57.526855+02:00
outcome: Fixed felt migrate to scan all directory fibers after migrating flat files and rewrite any depends-on values matching old hex IDs. Previously only rewrote deps in flat files being migrated, leaving pre-existing directory fibers with stale hex references. Test added.
---

(migration-rewrites-pre-existing)=
# Migration rewrites pre-existing deps
