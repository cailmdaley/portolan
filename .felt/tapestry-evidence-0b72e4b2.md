---
title: Evidence
status: open
tags:
    - tapestry:portolan-evidence
    - tapestry:portolan
    - tier:1
depends-on:
    - tapestry-structure-4401c64b
    - tapestry-interaction-74c5f450
created-at: 2026-02-21T17:18:11.04978+01:00
outcome: 'Evidence is traceability: every claim in a fiber outcome can be traced to a specific line in the source that produced it — computation or text.'
---

Evidence lives at `results/claims/{specName}/evidence.json`, where the spec name is the suffix of the fiber's `tapestry:` tag. The JSON holds an `evidence` object (metrics, provenance, any flat key-value context), an `output` object (artifact image filenames rendered in the sidebar), and a `generated` timestamp.

Three staleness states surface dependency health. **Fresh** (teal): this fiber's evidence postdates all its dependencies'. **Stale** (wine): at least one upstream dependency has newer evidence — the computation may be out of date. **No evidence** (umber): no `evidence.json` found. Staleness propagates through the DAG. A stale ancestor makes everything downstream stale.

Evidence is optional. Planning fibers, decision logs, documentation tapestries — umber dots here mean "no computation," not "something broken."

Uncertainty is metadata, not failure. A fiber that closes with "we don't know — and here's why" does more epistemic work than one that papers over doubt. The umber dot (no evidence) is not a gap — it's honest: this node hasn't been grounded yet. See `.felt/ai-mediated-science-the-2474bfcc.md` for why this matters as AI output accelerates.

**Paper provenance.** See `.felt/paper-provenance-8327b930.md` — fiber outcomes cite specific `.tex` source lines, rendered as clickable links. A result is only as trustworthy as the chain connecting it to its sources.
