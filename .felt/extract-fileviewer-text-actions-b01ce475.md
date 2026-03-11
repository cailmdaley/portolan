---
title: Extract FileViewer text actions from FileViewerTextEditor
status: closed
tags:
    - portolan
depends-on:
    - simplification-sweep-dca5deb0
created-at: 2026-03-11T17:33:13.735029+01:00
outcome: Extracted save-file persistence, clipboard copy feedback, and text download side effects into FileViewerTextActions.ts so FileViewerTextEditor.ts now focuses on CodeMirror lifecycle, dirty state, and markdown edit-mode transitions. Verified with npm run build and cd server && npm test.
---

FileViewerTextEditor still mixed editor runtime with file persistence and clipboard/download UI behavior. This pass isolates the button-driven text actions without changing modal behavior.
