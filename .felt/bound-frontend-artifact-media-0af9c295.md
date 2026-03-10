---
title: Bound frontend artifact media caches and preload lifecycle
status: closed
tags:
    - task
depends-on:
    - constitution-portolan-da3b0f59
created-at: 2026-03-01T16:42:36.15554+01:00
outcome: 'Implemented bounded cache policies plus deterministic teardown for artifact media paths. In src/ui/utils.ts, PDF doc/loading/page/aspect caches now use LRU limits with eviction hooks that cleanup page/doc resources and destroy loading tasks; image warm cache is also bounded. Added clearArtifactMediaCaches() and getArtifactMediaCacheStats() for explicit lifecycle ownership + diagnostics. In src/ui/TapestryView.ts, neighbor artifact preload cache is now LRU-bounded (64) and cleared on show/hide/showStatic transitions to prevent cross-session retention. In src/main.ts cleanupRuntime now calls clearArtifactMediaCaches(), aligning HMR/dev and production teardown behavior. Evidence: npm run build passed; cd server && npm test && npm run build passed (239 tests).'
---

Frontend media caches now have explicit ownership and bounded eviction for long-lived sessions. Scope: src/ui/utils.ts, src/ui/TapestryView.ts, src/main.ts.
