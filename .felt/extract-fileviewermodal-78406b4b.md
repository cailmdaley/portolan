---
title: Extract FileViewerModal annotation controller
tags:
    - '[portolan]'
depends-on:
    - id: simplification-sweep-dca5deb0
      label: documents one simplification pass within the sweep
created-at: 2026-03-10T18:51:15.687827+01:00
outcome: Extracted FileViewerModal's annotation subsystem into src/ui/FileViewerAnnotations.ts so the modal now coordinates loading and presentation while the controller owns annotation highlights, panel wiring, selection toolbars, image pinning, worker dispatch, and file-as-fiber actions. Verified with npm run build.
---
