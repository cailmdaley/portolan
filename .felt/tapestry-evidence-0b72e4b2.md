---
title: Evidence
status: open
tags:
    - tapestry:portolan
    - tier:1
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T17:18:11.04978+01:00
outcome: 'Fibers can connect to computation: a results directory with evidence.json holding metrics, timestamps, and artifact images. Staleness is determined by comparing evidence modification times across the dependency graph.'
---

Evidence lives at `results/claims/{specName}/evidence.json`, where the spec name comes from the fiber's `tapestry:` tag suffix. The JSON file contains an `evidence` object (flat dictionary of metrics), an `output` object (artifact filenames), and a `generated` timestamp. Evidence can come from any pipeline — snakemake rules, analysis scripts, notebooks — as long as they write this file.

Three staleness states: **fresh** (teal) means this fiber's evidence was generated after all its dependencies'. **Stale** (wine) means at least one upstream dependency has newer evidence — the computation may be out of date. **No evidence** (umber) means no evidence.json was found. Staleness propagates: a stale ancestor makes everything downstream stale. The colors surface this dependency health at a glance.

Evidence is optional. Fibers without evidence still render, still link, still hold their bodies and outcomes. The evidence layer is for research tapestries where computation is the substance: analysis pipelines, experiment results, model outputs. For planning tapestries, decision logs, or documentation tapestries like this one, evidence is absent by design — the umber dots mean 'no computation here,' not 'something is broken.'
