---
title: Paper provenance
tags:
    - tapestry:portolan
depends-on:
    - tapestry-evidence-0b72e4b2
created-at: 2026-02-22T05:37:48.924942+01:00
outcome: "ArXiv .tex source goes in results/references/. Fiber outcomes cite specific lines: results/references/2601.10038.tex:L23-29. The tapestry renders these as clickable links. Use .tex not PDF: line numbers are stable and addressable in source; PDFs have no reliable line structure."
---

Download arXiv `.tex` source with `arxiv-dl` or directly from `arxiv.org/abs/<id>` → Download → Source. Unpack if needed; the main `.tex` file goes in `results/references/<id>.tex`.

Cite in fiber outcomes as inline code: `results/references/2601.10038.tex:L23-29`. The tapestry renders this as a clickable link (the link format accepts `:L42` and `:L42-55`). In the interactive tapestry, clicking opens the file at that line in your editor. In the static tapestry, the link opens the file path directly.

This is provenance made structural. A claim in a fiber outcome is one click from the sentence that grounds it. The `.tex` source is exact — no OCR artifacts, no page-number ambiguity, no scroll-to-approximate. Line 23 of `2601.10038.tex` is line 23 of `2601.10038.tex`, always.

**Example.** Ting, Curtis-Trudel & Yao (arXiv:2601.10038) open with Mary Midgley's remark that philosophy is like plumbing — you don't notice it until things start to smell funny. Their point: as AI transforms astronomy, the epistemology becomes load-bearing. `results/references/2601.10038.tex:L23-29` is those sentences, made clickable from any fiber that cites them.
