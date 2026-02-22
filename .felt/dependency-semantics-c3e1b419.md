---
title: Dependency semantics
status: open
tags:
    - tapestry:portolan
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T17:18:22.13298+01:00
outcome: 'An edge A→B means B depends on A. If A changes, B may need updating. Staleness propagates downstream: a stale parent makes children stale. The DAG encodes both causal order and update sensitivity.'
---

An edge from A to B means B depends on A — A is upstream, B is downstream. The direction encodes causality: changing A may require updating B. This is the semantics that makes the tapestry auditable: any conclusion can be traced back through its dependencies to its foundations.

Dependencies are declared with `felt link <downstream-id> <upstream-id>`. They're stored in the fiber's YAML frontmatter as a `depends-on` list. In the tapestry, edges render as curved strands flowing left to right — upstream fibers sit in earlier columns, downstream fibers in later ones. An edge is visible only when both endpoints are visible.

The felt substrate is rhizomatic: any fiber can depend on any other fiber, across sections, across concerns. There's no imposed hierarchy — only the structure you actually file. A decision can depend on a question; a question can depend on a finding; a finding can depend on a spec. The DAG encodes the actual causal order of the work, not a simplified version of it.
