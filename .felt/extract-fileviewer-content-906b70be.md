---
title: Extract FileViewer content presenter
tags:
    - portolan
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-11T09:44:03.22517+01:00
status: closed
outcome: Extracted the remaining file-loading and media/text presentation subsystem out of FileViewerModal into FileViewerContentPresenter. The new presenter now owns current file identity, request cancellation, raw asset URL building, image/PDF rendering, text-file fetches, and annotation hydration, leaving FileViewerModal to coordinate modal chrome, navigation, and close semantics. Verified with `npm run build` and `cd server && npm test`.
---

Survey FileViewerModal.ts for remaining mixed concerns and extract the file-loading and media/text presentation subsystem so the modal shell only coordinates chrome, navigation, and close semantics.
