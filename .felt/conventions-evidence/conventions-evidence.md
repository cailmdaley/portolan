---
title: Conventions & Evidence
status: open
tags:
    - tapestry:portolan-evidence
    - tapestry:portolan
    - tier:1
depends-on:
    - fibers
    - click-me
created-at: 2026-02-21T17:18:11.04978+01:00
outcome: 'Evidence is traceability: every claim in a fiber outcome can be traced to a specific line in the source that produced it — computation or text.'
---

(conventions-evidence)=
Evidence is optional. Not every fiber represents a computation. Planning fibers, decision logs, documentation tapestries like this one — they have no `evidence.json`, and the umber dot beside them means "no computation," not "something broken." The staleness system accommodates absence without treating it as failure.

For fibers that do carry evidence: it lives at `results/claims/{specName}/evidence.json`, where the spec name is the suffix of the fiber's `tapestry:` tag. The JSON holds an `evidence` object (metrics, provenance, any flat key-value context), an `output` object (artifact image filenames rendered in the sidebar), and a `generated` timestamp.

Three staleness states surface dependency health. **Fresh** (teal): this fiber's evidence postdates all its dependencies'. **Stale** (wine): at least one upstream dependency has newer evidence — the computation may be out of date. **No evidence** (umber): no `evidence.json` found. Staleness propagates through the DAG. A stale ancestor makes everything downstream stale.

Uncertainty is metadata, not failure. A fiber that closes with "we don't know — and here's why" does more epistemic work than one that papers over doubt. The umber dot (no evidence) is not a gap — it's honest: this node hasn't been grounded yet. See `.felt/ai-mediated-science-the-2474bfcc.md` for why this matters as AI output accelerates.

**Making it work.** The conventions fiber below collects, in one place, every choice that makes a tapestry functional and useful — from tagging to evidence structure to paper provenance. For Snakemake workflows, a second fiber maps the rule structure onto these conventions directly.
