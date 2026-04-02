---
title: Frontend lifecycle hardening
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T16:29:45.755615+01:00
outcome: 'Closed two frontend lifecycle gaps. (1) src/main.ts now owns teardown for all canvas/document/window listeners, reconnect timeout, mock-data timeout, and render-loop RAF via a single cleanupRuntime path used by HMR dispose; connectWebSocket now guards against post-dispose reconnect and duplicate reconnect timers. (2) src/ui/TapestryView.ts now has abortable guarded tapestry fetch lifecycle for show/refresh (AbortController + request IDs), owned timeout/RAF cleanup for hide/re-render transitions, tooltip/static modal teardown in dispose, and static file modal keydown cleanup for all close paths. Evidence: npm run build passed; cd server && npm test && npm run build passed (239 tests).'
---

(frontend-lifecycle-hardening)=
# Frontend lifecycle hardening
