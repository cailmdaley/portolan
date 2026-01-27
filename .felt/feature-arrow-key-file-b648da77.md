---
title: 'Feature: Arrow key file navigation in FileViewerModal'
status: closed
kind: spec
priority: 2
created-at: 2026-01-27T03:07:09.231903+01:00
closed-at: 2026-01-27T03:07:09.231908+01:00
close-reason: |-
    Up/Down arrows cycle through files when viewing from a list (worker activity or recent files).

    **Behavior:**
    - Editor focused → arrows move cursor (CodeMirror handles it)
    - Editor NOT focused → arrows navigate to prev/next file
    - Wraps around at list ends
    - Checks for unsaved changes before navigating

    **Implementation:**
    1. FileViewerModal tracks `navigationFiles: string[]` and `navigationIndex: number`
    2. `show()` accepts optional `navigationContext: { files, index }`
    3. Keyboard handler checks `this.editorView?.hasFocus` before navigating
    4. WorkerActivityPanel/CityPanel expose `getFilePaths()` and `getFileIndex()` methods
    5. main.ts wires up context when opening files

    **Usage:** Click outside editor (header, annotations panel) to unfocus, then use arrows.

    Files: src/ui/FileViewerModal.ts, src/ui/WorkerActivityPanel.ts, src/ui/CityPanel.ts, src/main.ts
---
