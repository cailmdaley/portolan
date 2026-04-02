---
title: Image path resolution in rendered markdown
tags:
    - '[portolan]'
depends-on:
    - rendered-markdown-by-default
created-at: 2026-02-12T11:05:50.802913+01:00
outcome: 'renderMarkdown() accepts {basePath, originId}. Relative images resolved via /file-content?raw=true — new endpoint returning actual binary with Content-Type. FileViewerModal uses cityPath (project root) as base. Remote images via SSH base64. Cache-Control: max-age=3600.'
---

(image-path-resolution-in)=
# Image path resolution in rendered markdown
