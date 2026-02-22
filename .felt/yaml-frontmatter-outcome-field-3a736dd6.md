---
title: 'YAML frontmatter: outcome field with colon causes parse failure'
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T05:29:21.439528+01:00
outcome: 'If outcome contains a colon followed by a space (e.g. ''a causal record: walk upstream''), YAML parser treats it as a mapping key and fails with ''mapping values are not allowed in this context''. Fix: quote the outcome value in YAML (outcome: "..."). tapestry-structure-4401c64b.md was silently absent from tapestry for this reason — the fiber had tier:1 and tapestry:portolan tags but was never visible. Closed: f323cc4.'
---
