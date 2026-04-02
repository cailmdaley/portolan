---
title: Extract FileViewer felt context from markdown view
status: closed
tags:
    - task
depends-on:
    - simplification-sweep
created-at: 2026-03-11T17:27:31.012385+01:00
closed-at: 2026-03-11T17:30:19.620405+01:00
outcome: Extracted the felt-specific markdown subsystem from FileViewerMarkdownView into FileViewerFiberContext so the view now only coordinates rendered markdown display, inline-path navigation, edit-mode entry, and selection forwarding. Verified with npm run build and cd server && npm test.
---

(extract-fileviewer-felt-context)=
# Extract FileViewer felt context from markdown view
