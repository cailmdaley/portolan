---
title: Extracted file viewer annotation transport from UI controller
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-11T17:59:36.700079+01:00
outcome: First pass moved file-as-fiber formatting, annotation CRUD requests, annotation reloads, and worker-send requests into FileViewerAnnotationActions.ts with shared annotation types in FileViewerAnnotationTypes.ts. Later sweeps extracted button visibility, global-comment tracking, worker picker loading, send-to-worker dispatch, and file-as-fiber feedback into FileViewerAnnotationTransport.ts, then split preview rendering, panel refresh/goto behavior, guarded image-annotation persistence, and shared annotation list state into FileViewerAnnotationPanelController.ts. FileViewerAnnotations.ts now sits at 208 LOC and focuses on top-level coordination, highlight application, and delegation to transport, panel, text, and image modules.
---
