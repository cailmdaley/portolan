---
title: Symbol strip for section fiber count
status: closed
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
    - skeleton-view-rendering-2e55e587
created-at: 2026-02-21T18:50:22.954154+01:00
outcome: 'Decided against dot pooling (too complex to get right without fine-tuning). Symbol strip: colored tspan elements (● for fresh/stale, ○ for no-evidence) below the label. Each symbol colored by its own fiber''s staleness — not the section''s. Capped at 8, overflow shown as +N. Colors: DOT_STALENESS_COLORS — forest green #215838, wine red #74232e, umber #443e38.'
---
