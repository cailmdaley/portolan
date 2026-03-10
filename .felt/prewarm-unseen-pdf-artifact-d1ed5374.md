---
title: Prewarm unseen PDF artifact sizing
status: closed
tags:
    - portolan
depends-on:
    - adopt-pdf-js-for-scalable-af0bd57c
created-at: 2026-02-25T17:10:25.99874+01:00
outcome: Added proactive PDF prewarming for gallery entries so unseen PDFs have page metadata cached before arrow-key navigation. Reserved PDF tile layout with aspect-ratio placeholder (default + cached override), then render into canvas without first-time resize jump. This targets the first-view default-size-then-resize artifact while keeping lazy PDF.js loading and stable redraw behavior. Verified with npm run build.
---
