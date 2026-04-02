---
title: Use raw media transport in file viewer and tighten tapestry detail/lightbox teardown
status: closed
depends-on:
    - constitution-portolan
created-at: 2026-03-01T16:49:07.607675+01:00
outcome: 'Switched src/ui/FileViewerModal.ts image/PDF paths from /file-content?binary=true JSON base64 responses to direct /file-content?raw=true URLs (with originId), while preserving request-id/AbortController guards and annotation fetch ownership. In src/ui/TapestryView.ts added explicit cleanupDetailBindings() + closeActiveLightbox() ownership, wired into hideDetail()/hide()/reopen flows so document-level key handlers and delegated artifact listeners cannot leak across close cycles. Updated src/ui/utils.ts markdown comment to match raw transport path. Evidence: npm run build passed; cd server && npm test passed (239 tests); cd server && npm run build passed.'
---

(use-raw-media-transport-in-file)=
# Use raw media transport in file viewer and tighten tapestry detail/lightbox teardown
