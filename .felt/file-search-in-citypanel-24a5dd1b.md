---
title: File search in CityPanel
status: closed
kind: task
priority: 2
depends-on:
    - file-viewer-enhancements-edit-ad76b5ca
created-at: 2026-01-21T22:12:44.142885+01:00
closed-at: 2026-01-21T22:12:55.341437+01:00
close-reason: |-
    Implemented filesystem search per city in hexarchy CityPanel.

    Components:
    - server/src/MessageRouter.ts: Added SearchFilesMessage type
    - server/src/index.ts: handleSearchFiles() with fd/rg (fallback to find/grep)
    - src/ui/CityPanel.ts: Search input, mode toggle (Name/Content), results list
    - index.html: CSS for file search (light + dark themes)
    - src/main.ts: Wired onOpenFile callback to FileViewerModal

    Search uses fd for filename, rg for content. Both installed via homebrew. Falls back to find+grep if tools missing (e.g., remote machines).

    150ms debounce, cancels stale searches, limits to 50 results. Click result opens FileViewerModal.
---
