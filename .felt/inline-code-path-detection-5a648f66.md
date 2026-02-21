---
title: 'Inline code path detection: clickable file refs in rendered markdown'
tags:
    - portolan
depends-on:
    - clickable-file-paths-from-7e9ed854
    - tapestryview-fileviewermodal-c3150cda
created-at: 2026-02-20T02:16:43.239427+01:00
outcome: 'attachInlinePathListeners(container, openFile) added to utils.ts. Scans code.md-inline-code elements; INLINE_PATH_RE requires a path separator (/) and file extension, optional :linenum suffix. Matched elements get cursor:pointer, title tooltip, and click handler. Styled via .md-inline-code[title] — the title attribute distinguishes clickable paths from plain inline code. Called after highlight+interpolate in TapestryView (detail body, body-editor save, fiber sidebar) and FileViewerModal (showRenderedMarkdown). In FileViewerModal, resolves relative paths against currentCityPath || dirPath. CSS specificity fix needed: context rules (.tapestry-detail-body code, .file-viewer-markdown code) override class selectors — added qualified selectors .tapestry-detail-body .md-inline-code[title] etc. to win.'
---
