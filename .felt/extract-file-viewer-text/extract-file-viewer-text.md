---
title: Extract file viewer text annotation runtime
status: closed
tags:
    - \[portolan\]
depends-on:
    - simplification-sweep
created-at: 2026-03-11T18:03:30.506881+01:00
outcome: Extracted selection mapping, toolbar UI, and text annotation persistence into FileViewerTextAnnotations.ts. FileViewerAnnotations.ts now coordinates the annotation panel, highlight state, worker handoff, file-as-fiber actions, and media-specific delegates. Verified with npm run build and cd server && npm test.
---

(extract-file-viewer-text)=
Split the remaining text-selection annotation subsystem out of FileViewerAnnotations.ts so the coordinator only owns panel state, worker/fiber actions, highlight updates, and image/text delegation.
