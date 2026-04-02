---
title: Add frontend runtime diagnostics surface
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T17:29:23.033964+01:00
closed-at: 2026-03-01T17:32:42.801914+01:00
outcome: 'Added a unified frontend runtime diagnostics surface for long-running memory/performance audits. src/main.ts now tracks activity ingress throughput (rolling 60s + total counters), coalesced HUD update counts, and exposes window.getFrontendRuntimeDiagnostics() plus window.debugRuntime() (combined frontend snapshot + server /debug-runtime fetch). Added component-scoped diagnostics ownership via getRuntimeStats() in src/render/ZoneRenderer.ts, src/ui/CityHUD.ts, src/ui/FileViewerModal.ts, src/ui/TapestryView.ts, and src/ui/PlaygroundViewer.ts so listener/cached/async state cardinalities are inspectable at runtime. Evidence: npm run build; cd server && npm test && npm run build.'
---

(add-frontend-runtime)=
# Add frontend runtime diagnostics surface
