---
title: RevealJS viewing
status: closed
created-at: 2026-03-15T00:20:11.939236+01:00
closed-at: 2026-03-15T00:22:14.990056+01:00
outcome: Added GET /project-file/<absolute-path> to the local HTTP API, implemented as streamed local file serving with extension-based MIME types and 404 handling. Reused the existing file-content transport layer so the route lives with related file-serving logic, then taught the live file viewer to treat local .html files as iframe previews backed by /project-file, which preserves RevealJS relative CSS/JS/image resolution inside project docs. Added server tests for MIME-typed project-file streaming and missing-file 404s; npm test passes in server/.
---
