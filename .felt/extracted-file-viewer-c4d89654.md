---
title: Extracted file viewer annotation transport from UI controller
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-11T17:59:36.700079+01:00
outcome: Moved file-as-fiber formatting, annotation CRUD requests, annotation reloads, and worker-send requests into FileViewerAnnotationActions.ts, with shared annotation types in FileViewerAnnotationTypes.ts. FileViewerAnnotations.ts dropped to 601 LOC and now focuses on selection UI, highlight application, panel state, and guarded result application.
---
