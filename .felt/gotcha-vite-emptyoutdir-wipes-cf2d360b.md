---
title: 'Gotcha: Vite emptyOutDir wipes exported data'
status: closed
kind: decision
tags:
    - portolan
priority: 2
created-at: 2026-02-10T15:18:44.623954+01:00
closed-at: 2026-02-10T15:18:44.623961+01:00
close-reason: 'vite.static.config.ts must use emptyOutDir: false. The docs/ directory contains both Vite build output (index.html, assets/) and exported data (data/rhizome.json, data/claims/). With emptyOutDir: true, every build nukes the exported data. Build order matters: build:static first, export:rhizome second.'
---
