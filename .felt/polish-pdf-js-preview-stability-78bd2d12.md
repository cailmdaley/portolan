---
title: Polish PDF.js preview stability
status: closed
tags:
    - portolan
depends-on:
    - adopt-pdf-js-for-scalable-af0bd57c
created-at: 2026-02-25T17:08:32.748592+01:00
outcome: Polished PDF.js artifact preview path by simplifying worker setup (static worker URL + lazy pdfjs import), promoting PDF document/page caches to shared module scope, and stabilizing resize rendering (width-only gate, RAF-throttled observer, serialized draw loop, DPR cap). This removes runaway growth behavior and keeps previews visible/crisp while retaining lazy loading. Verified with npm run build.
---
