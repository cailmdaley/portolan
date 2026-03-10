---
title: Adopt PDF.js for scalable artifact previews
status: closed
tags:
    - portolan
depends-on:
    - pdf-artifact-support-in-tapestry-7049938c
created-at: 2026-02-25T17:00:27.530857+01:00
closed-at: 2026-02-25T17:01:50.787392+01:00
outcome: Adopted PDF.js for gallery PDF previews so rendered PDF content now scales with sidebar resizing (not just the iframe/container). Replaced sidebar PDF iframe preview path with canvas rendering of page 1 via pdfjs-dist, configured worker source, added resize-aware rerendering, and retained overlay click behavior for lightbox open. Updated app/static CSS from iframe-based loading styles to canvas-based styles. Added dependency pdfjs-dist. Verified with npm run build.
---
