---
title: Preserve reveal.js slide hash across HTML view refresh in Portolan viewer
status: closed
created-at: 2026-03-15T13:55:50.71028+01:00
closed-at: 2026-03-15T14:00:08.703257+01:00
outcome: File viewer refresh now preserves HTML iframe URL state, including reveal.js slide hashes. Portolan injects a small postMessage bridge into /project-file HTML responses so the parent viewer can track hash/history changes across the :4004 iframe boundary, then reopens the iframe with the preserved URL plus cache-busting on refresh. Verified with npm run build and the HttpApi file-content test suite.
---

(preserve-reveal-js-slide-hash)=
# Preserve reveal.js slide hash across HTML view refresh in Portolan viewer
