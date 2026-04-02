---
title: Extract FileViewer image annotation UI from FileViewerAnnotations
status: closed
tags:
    - portolan
depends-on:
    - simplification-sweep
created-at: 2026-03-11T09:39:52.975329+01:00
outcome: Extracted image-point marker rendering, click-to-annotate popover lifecycle, and outside-click cleanup into FileViewerImageAnnotations.ts so FileViewerAnnotations.ts now focuses on text-selection annotation workflow, worker handoff, and filing feedback. Verified with npm run build and cd server && npm test.
---

(extract-fileviewer-image)=
FileViewerAnnotations mixed text-range annotation workflow with a separate image-point UI subsystem.
This pass splits the image concern into its own controller without changing modal behavior.
