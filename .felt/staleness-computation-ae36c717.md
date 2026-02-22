---
title: Staleness computation
status: open
tags:
    - tapestry:portolan
depends-on:
    - tapestry-structure-4401c64b
    - tapestry-evidence-0b72e4b2
created-at: 2026-02-21T17:18:30.594391+01:00
outcome: 'Fresh: evidence newer than all dependencies. Stale: at least one dependency has newer evidence. No-evidence: no evidence.json found. Staleness colors: teal (fresh), red (stale), gray (no-evidence).'
---

Each tapestry node has a staleness state determined by comparing evidence modification times across the dependency graph. If a fiber's evidence was generated after all its upstream dependencies' evidence, it's **fresh**. If any upstream has newer evidence, it's **stale** — the computation may not reflect the current state of its inputs. If no evidence exists, it's **no-evidence**.

Staleness propagates. A stale ancestor makes every downstream node stale, even if those nodes' own evidence is newer. This is intentional: staleness means the full dependency chain hasn't been consistently recomputed, so downstream confidence is uncertain. The color field makes this visible at a glance: forest green (fresh), wine red (stale), umber (no evidence).

The staleness system works with any pipeline. Snakemake naturally produces `evidence.json` at the right location when rules are structured correctly — reruns happen automatically when inputs change. But the tapestry doesn't require snakemake; any script that writes `results/claims/{specName}/evidence.json` and updates its timestamp participates in the staleness graph.
