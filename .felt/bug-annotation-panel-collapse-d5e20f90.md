---
title: 'Bug: Annotation panel collapse pushed off modal'
status: closed
kind: decision
priority: 2
created-at: 2026-01-25T15:22:02.061123+01:00
closed-at: 2026-01-25T15:22:02.061126+01:00
close-reason: |-
    Problem: When collapsed to 40px, the annotation panel was pushed off the right edge of the modal, making it impossible to un-minimize.

    Fix: Added flex-shrink: 0 to .file-viewer-annotations. When collapsed, header centers toggle button and hides label + clear button. The 40px strip with toggle stays visible and clickable.
---
