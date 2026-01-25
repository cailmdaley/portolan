---
title: 'Feature: File as Fiber button in FileViewerModal'
status: closed
kind: task
priority: 2
depends-on:
    - file-annotations-in-e8dbee22
created-at: 2026-01-25T15:22:11.260027+01:00
closed-at: 2026-01-25T15:22:11.260037+01:00
close-reason: |-
    Added 'File as Fiber' button next to 'Send to Worker'. Creates fiber from annotations + global comment.

    Implementation:
    - FileViewerModal.ts: fiberBtn property, fileAsFiber() method
    - HttpApi.ts: /file-as-fiber endpoint
    - Formats annotations as markdown body, calls felt add (local or via SSH for remote)
    - Buttons now appear when annotations OR global comment has content (can file just a comment)

    Gotcha discovered: felt add returns plain text fiber ID, not JSON. Don't use --json flag.
---
