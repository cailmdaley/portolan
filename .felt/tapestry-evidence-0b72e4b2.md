---
title: Evidence
status: open
tags:
    - tapestry:portolan-evidence
    - tapestry:portolan
    - tier:1
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T17:18:11.04978+01:00
outcome: 'Evidence is traceability: every claim in a fiber outcome can be traced to a specific line in the source that produced it — computation or text.'
---

Evidence lives at `results/claims/{specName}/evidence.json`, where the spec name is the suffix of the fiber's `tapestry:` tag. The JSON holds an `evidence` object (metrics, provenance, any flat key-value context), an `output` object (artifact image filenames rendered in the sidebar), and a `generated` timestamp.

Three staleness states surface dependency health. **Fresh** (teal): this fiber's evidence postdates all its dependencies'. **Stale** (wine): at least one upstream dependency has newer evidence — the computation may be out of date. **No evidence** (umber): no `evidence.json` found. Staleness propagates through the DAG. A stale ancestor makes everything downstream stale.

Evidence is optional. Planning fibers, decision logs, documentation tapestries — umber dots here mean "no computation," not "something broken."

**Paper provenance.** ArXiv papers go in `results/references/`. Fiber outcomes cite specific lines: `results/references/2601.10038.pdf:L23-29`. The tapestry renders these as clickable links that open the PDF at that line.

This fiber is its own example. Ting, Curtis-Trudel & Yao (arXiv:2601.10038) open with Mary Midgley's remark that philosophy is like plumbing — you don't notice it until things start to smell funny. Their point: as AI transforms astronomy, scientists are beginning to notice. The same is true of provenance. A result is only as trustworthy as the chain connecting it to its sources. `results/references/2601.10038.pdf:L23-29` is that chain made visible — one click from the claim to the sentence that grounds it.
