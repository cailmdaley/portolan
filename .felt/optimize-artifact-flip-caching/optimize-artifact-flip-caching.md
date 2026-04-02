---
title: Optimize artifact flip caching
status: closed
tags:
    - portolan
depends-on:
    - pdf-artifact-support-in-tapestry
created-at: 2026-02-25T17:11:30.403114+01:00
closed-at: 2026-02-25T17:12:18.122004+01:00
outcome: 'Optimized artifact carousel caching/flip behavior across images and PDFs: added shared image prewarm cache (decode/load), unified warmArtifact path, proactive adjacent artifact warming during navigation, and initial current-item warming on attach. Added image loading-state fade handling analogous to PDFs to reduce first-view flicker. Existing PDF prewarm/reserve/aspect path retained. Verified with npm run build.'
---

(optimize-artifact-flip-caching)=
# Optimize artifact flip caching
