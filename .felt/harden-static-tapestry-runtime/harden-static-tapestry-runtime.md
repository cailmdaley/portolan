---
title: Harden static tapestry runtime lifecycle and async guards
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T17:11:09.868886+01:00
closed-at: 2026-03-01T17:12:57.12477+01:00
outcome: 'Hardened static export lifecycle ownership in src/static/main.ts by introducing an explicit runtime owner for TapestryView, named popstate listener attach/detach, abortable fetch lifecycle (AbortController + request IDs), deterministic beforeunload/HMR cleanup via view.dispose(), and stale async completion guards. This aligns static mode teardown semantics with the main runtime and prevents listener/resource leaks across reload/navigate cycles. Evidence: npm run build passed; npm run build:static passed; cd server && npm test && npm run build passed (244 tests).'
---

(harden-static-tapestry-runtime)=
Ensure static export runtime has explicit ownership/teardown for global listeners and async fetch completion, including HMR-safe cleanup paths aligned with production lifecycle behavior.
