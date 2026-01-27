---
title: 'Bug: Escape/click in FileViewerModal closes parent panels'
status: closed
kind: decision
priority: 2
created-at: 2026-01-27T03:06:59.266031+01:00
closed-at: 2026-01-27T03:06:59.266035+01:00
close-reason: |-
    CityPanel and WorkerActivityPanel have document-level keydown (Escape) and click handlers that fire when FileViewerModal is open, causing panels to close unexpectedly.

    **Why stopImmediatePropagation didn't work:** Event listeners fire in registration order. FileViewerModal is created *after* panels (main.ts:87,90,93), so its handlers register last. stopImmediatePropagation only stops handlers registered after the current one.

    **Fix:** Have parent panels check for modal visibility:
    ```typescript
    // In Escape handler:
    const fileViewer = document.querySelector('.file-viewer-modal.visible')
    if (fileViewer) return

    // In click-outside handler:
    if (fileViewer?.contains(target)) return
    const fileViewerBackdrop = document.querySelector('.file-viewer-backdrop.visible')
    if (fileViewerBackdrop?.contains(target)) return
    ```

    Files: src/ui/CityPanel.ts, src/ui/WorkerActivityPanel.ts
---
