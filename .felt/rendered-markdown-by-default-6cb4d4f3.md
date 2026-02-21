---
title: Rendered markdown by default with double-click-to-edit
tags:
    - '[portolan]'
created-at: 2026-02-12T11:04:52.842341+01:00
outcome: 'RhizomeView detail panel and FileViewerModal now render markdown by default. Double-click swaps to CodeMirror editor (vim, markdown syntax). RhizomeView: Cmd+S saves body back to .felt/<id>.md (preserving YAML frontmatter), Escape discards. FileViewerModal: .md files render with file-viewer-markdown styles, double-Escape from editor returns to rendered view. Annotation in rendered mode maps browser Selection to raw markdown offsets via whitespace-normalized string matching.'
---
