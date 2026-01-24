---
title: 'PDF viewing: binary files need base64 data URL pattern'
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T16:23:05.759113+01:00
closed-at: 2026-01-22T16:23:16.383235+01:00
close-reason: |-
    Binary files (images, PDFs) cannot be read as UTF-8 text — they get corrupted. Pattern for FileViewerModal:

    Server (HttpApi.ts):
    - Check extension for binary types (isPdfExtension, isImageExtension)
    - Fetch via readFile (local) or ssh base64 (remote)
    - Return JSON with { type: 'pdf'/'image', url: 'data:mime;base64,...' }
    - Larger buffer/timeout for PDFs (50MB, 60s)

    Client (FileViewerModal.ts):
    - Check extension before fetching
    - Request with binary=true param
    - Display in <iframe> (PDF) or <img> (images)

    Already implemented for images; extended for PDFs in this session.
---
