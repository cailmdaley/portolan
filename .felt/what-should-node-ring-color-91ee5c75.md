---
title: What should node ring color encode? Alternatives to staleness
tags:
    - portolan
    - question
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T06:44:03.118857+01:00
outcome: 'Open. Staleness (fresh/stale/no-evidence) makes sense for computational tapestries where snakemake rules generate evidence.json with real timestamps. For documentation tapestries, timestamps are manual and color variation is arbitrary. Alternatives considered: (1) kind-based — decision=amber, question=cool, spec=neutral; (2) age/recency of fiber body edit — recently edited = warmer; (3) connection density — high-degree nodes more saturated; (4) keep staleness but neutral for no-evidence nodes (current behavior). User preference: staleness should be 1-hop only (already the case). Dot strips: currently show staleness of 1-hop neighbors — could instead show just count (monochrome), or kind-based color.'
---
