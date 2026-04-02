---
title: 'Link format: :L42-55 accepted alongside plain :42 for file line references'
status: closed
tags:
    - portolan,decision
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-22T05:29:32.95813+01:00
closed-at: 2026-02-22T07:01:08.041988+01:00
outcome: 'INLINE_PATH_RE in src/ui/utils.ts now accepts :L42 and :L42-55 (GitHub-style line ranges) in addition to plain :42. Line extractor strips the L prefix and takes the start of the range. Convention: either format works — use whichever is natural when citing sources like results/references/smith2024.tex:L42-55. Commit d323cc4.'
---

(link-format-l42-55-accepted)=
# Link format: :L42-55 accepted alongside plain :42 for file line references
