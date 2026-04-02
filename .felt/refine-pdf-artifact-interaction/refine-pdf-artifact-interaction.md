---
title: Refine PDF artifact interaction and sizing
status: closed
tags:
    - portolan
depends-on:
    - pdf-artifact-support-in-tapestry
created-at: 2026-02-25T16:00:10.275799+01:00
closed-at: 2026-02-25T16:00:16.777511+01:00
outcome: Made PDF artifacts fully clickable in gallery via overlay button above iframe (same lightbox open path as images), added PDF aspect ratio probing from /MediaBox to size sidebar iframe containers to document proportions with shrink-to-fit behavior, and updated app/static artifact CSS to use media wrappers instead of fixed iframe heights. Verified with npm run build.
---

(refine-pdf-artifact-interaction)=
# Refine PDF artifact interaction and sizing
