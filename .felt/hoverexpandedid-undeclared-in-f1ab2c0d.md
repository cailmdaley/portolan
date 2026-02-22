---
title: hoverExpandedId undeclared in click handler — dead code from hover-reveal removal
status: closed
tags:
    - portolan
depends-on:
    - hover-simplified-tooltip-only-9931916d
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T04:25:26.040987+01:00
outcome: 'hoverExpandedId was referenced in the drag .on(''end'') click handler at TapestryView.ts:911 but never declared. It was a remnant of the hover-reveal era (hover used to expand nodes and hoverExpandedId tracked them). When hover was simplified to tooltip-only in iteration 11, the hover reveal code was removed but the click handler check was left behind. Caused TS2304 compile error. Fix: removed the hoverExpandedId branch entirely (lines 911-913); normal toggle logic unchanged. Commit 94c256a.'
---
