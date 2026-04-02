---
title: Clickable file paths from search results with line number jump
tags:
    - portolan
depends-on:
    - tapestryview-fileviewermodal
created-at: 2026-02-20T02:16:30.164285+01:00
outcome: CityHUD search result file items now carry data-line attribute. Click handler reads it and passes to openFile(path, line). onOpenFile callback signature extended to (fullPath, originId, cityPath, cityId, line?). main.ts threads line to fileViewerModal.show(). FileViewerModal.show gains jumpToLine param; new scrollToLine() private method dispatches CodeMirror selection + EditorView.scrollIntoView after editor creation. TapestryView.setOnOpenFile and openFileFromLink similarly extended for line threading.
---

(clickable-file-paths-from)=
# Clickable file paths from search results with line number jump
