---
title: Stabilize lazy PDF preview render
status: closed
tags:
    - portolan
depends-on:
    - adopt-pdf-js-for-scalable
created-at: 2026-02-25T17:03:36.124529+01:00
outcome: 'Fixed PDF preview regression after PDF.js adoption by lazy-loading pdfjs-dist on demand and stabilizing resize redraw logic: width-gated rerenders, serialized draw calls, and loading-state fallback when page load fails. This prevents runaway growth on load and restores visible preview rendering. Verified with npm run build.'
---

(stabilize-lazy-pdf-preview)=
# Stabilize lazy PDF preview render
