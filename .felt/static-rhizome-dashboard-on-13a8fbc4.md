---
title: Static rhizome dashboard on GitHub Pages
status: closed
kind: task
tags:
    - portolan
priority: 2
depends-on:
    - gotcha-vite-emptyoutdir-wipes-cf2d360b
    - absorb-claims-dashboard-into-ed04e0e9
    - rhizome-endpoint-returns-full-2a1e18b5
created-at: 2026-02-10T15:18:38.842817+01:00
closed-at: 2026-02-10T15:18:38.842822+01:00
close-reason: 'Built static export of RhizomeView for GitHub Pages at cailmdaley.github.io/portolan/. Three pieces: (1) RhizomeView.showStatic() with staticMode flag — guards 5 server calls, uses local asset paths via artifactUrl() helper. (2) Separate Vite build target (vite.static.config.ts, root: src/static, base: ./, outDir: docs). (3) Export script (scripts/export-rhizome.ts) fetches /rhizome endpoint + downloads artifact images. Key gotcha: emptyOutDir must be false or build wipes exported data. Build order: build:static first, then export:rhizome.'
---
