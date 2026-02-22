---
title: 'Link format: :L42-55 accepted alongside plain :42 for file line references'
tags:
    - portolan,decision
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T05:29:32.95813+01:00
outcome: 'INLINE_PATH_RE in src/ui/utils.ts now accepts :L42 and :L42-55 (GitHub-style line ranges) in addition to plain :42. Line extractor strips the L prefix and takes the start of the range. Convention: either format works — use whichever is natural when citing sources like results/references/smith2024.tex:L42-55. Commit d323cc4.'
---
