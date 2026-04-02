---
title: What should node ring color encode? Alternatives to staleness
status: closed
tags:
    - portolan
    - question
depends-on:
    - pyramid-tapestry-tiered
created-at: 2026-02-22T06:44:03.118857+01:00
closed-at: 2026-02-22T07:19:37.87926+01:00
outcome: 'Keep staleness. For computational tapestries (snakemake evidence), staleness is the right signal — teal=fresh, red=stale, gray=no-evidence. For documentation tapestries (like portolan self-reference), all nodes render gray, which is correct and honest: they have no evidence and shouldn''t pretend otherwise. Kind-based and age-based alternatives considered but rejected — they add complexity without carrying meaningful signal about whether analysis needs revisiting. Dot strips on section nodes continue to show staleness of 1-hop neighbors (monochrome darker variants). Decision: staleness stays as primary color encoding.'
---

(what-should-node-ring-color)=
# What should node ring color encode? Alternatives to staleness
