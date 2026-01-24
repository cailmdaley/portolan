---
title: 'FileViewerModal: refresh button and line wrapping'
status: closed
kind: task
priority: 2
created-at: 2026-01-24T14:45:27.281114+01:00
closed-at: 2026-01-24T14:45:27.281122+01:00
close-reason: |-
    Added two small UX improvements to FileViewerModal:

    1. **Refresh button (↻)** — In header between 'Send to Worker' and 'Copy'. Calls show() again with current file path/originId. Prompts if unsaved changes. Doesn't work for binary files (images/PDFs) since currentContent is null for those.

    2. **Line wrapping** — Added EditorView.lineWrapping to CodeMirror extensions. Long lines now wrap instead of horizontal scroll.

    Linter also cleaned up unused imports (diff2html, Diff) that were left over from removed diff functionality.
---
