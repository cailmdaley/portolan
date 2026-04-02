---
title: Extract file viewer content loading runtime
status: closed
tags:
    - portolan
depends-on:
    - simplification-sweep
created-at: 2026-03-11T17:34:50.514463+01:00
closed-at: 2026-03-11T17:37:06.381674+01:00
outcome: Split src/ui/FileViewerContentPresenter.ts along the remaining seam between request ownership and file presentation. Extracted extension detection, file-content and annotation fetches, raw asset URL building, image/PDF rendering, and text/markdown presentation into src/ui/FileViewerContentLoader.ts. FileViewerContentPresenter.ts now only tracks current file identity, manages abortable show requests, resets transient viewer state, and delegates presentation. Verified with npm run build and cd server && npm test.
---

(extract-file-viewer-content)=
Surveying the remaining simplification sweep targets showed that src/ui/FileViewerContentPresenter.ts still mixes two concerns: race-safe request ownership for file loads, and the actual media/text loading and presentation workflow for images, PDFs, and text files with annotation hydration. This iteration should split the latter into its own module so the presenter becomes a thin coordinator over request state and current file identity.
