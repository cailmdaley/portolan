---
title: 'Static tapestry background bug: missing canvas color'
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T03:47:38.841268+01:00
closed-at: 2026-02-22T03:49:49.283936+01:00
outcome: Static index.html had no background on .tapestry-dag, causing knockout nodes (#E8DDD0) to appear as off-color blobs against parchment body (#D8CBBA). Fixed by adding explicit background + radial gradient to match main index.html.
---
