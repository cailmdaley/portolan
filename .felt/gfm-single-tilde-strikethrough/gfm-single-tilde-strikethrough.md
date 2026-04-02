---
title: GFM single-tilde strikethrough fix in markdown renderer
status: closed
tags:
    - portolan,gotcha
created-at: 2026-02-19T23:40:58.290401+01:00
outcome: marked's GFM del rule uses ~~? which matches both ~text~ and ~~text~~. Approximation signs like ~2 days become strikethrough when two appear in the same paragraph. Fixed by adding a marked hooks.preprocess that escapes lone tildes (runs of odd-length ~) to &#126; before tokenization, leaving ~~ pairs intact. Located in src/ui/utils.ts.
---

(gfm-single-tilde-strikethrough)=
# GFM single-tilde strikethrough fix in markdown renderer
