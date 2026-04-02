---
title: Snakemake conventions for tapestry
tags:
    - tapestry:portolan
depends-on:
    - tapestry-conventions
created-at: 2026-02-22T06:23:22+01:00
outcome: 'Rule name = specName. Rule outputs evidence.json at results/claims/{rulename}/. Script writes id/input/output/params/evidence/generated fields from snakemake.* objects. Staleness is automatic: snakemake reruns the rule when inputs change, writing a fresh evidence.json that the tapestry picks up.'
---

(snakemake-conventions-for)=
The rule name is the specName. A rule named `cosebis` corresponds to a fiber tagged `tapestry:cosebis` and writes evidence to `results/claims/cosebis/evidence.json`.

**Directory layout:**
```
results/claims/{rulename}/
    evidence.json       # required — drives staleness and sidebar
    {plot}.png          # optional — listed in output field, renders as artifact
```

**Rule structure:**
```python
rule cosebis:
    input:
        spectra="results/data/{sample}/spectra.npz"
    output:
        plot="results/claims/cosebis/cosebis.png",
        evidence="results/claims/cosebis/evidence.json"
    params:
        nside=config["nside"],
        lmin=config["lmin"]
    script:
        "workflow/scripts/cosebis.py"
```

**In the script, write evidence.json** directly from the snakemake objects:
```python
import json, datetime

evidence = {
    "id": snakemake.rule,
    "generated": datetime.datetime.utcnow().isoformat(),
    "input": dict(snakemake.input),
    "output": dict(snakemake.output),
    "params": dict(snakemake.params),
    "evidence": {
        "pte": pte,
        "chi2": chi2,
        "dof": dof,
    }
}
with open(snakemake.output.evidence, "w") as f:
    json.dump(evidence, f, indent=2)
```

The `output` field maps output names to filenames. Only image files in `output` render as sidebar artifacts — non-image outputs (including `evidence.json` itself) are silently skipped.

**Wire the felt fiber** after creating the rule:
```bash
felt add "B-modes consistent with zero" -t tapestry:cosebis
felt link <new-id> <upstream-fiber-id>
```

**Staleness is automatic.** Snakemake reruns the rule when inputs change, writing a fresh `evidence.json`. The tapestry compares mtime up the dependency chain — no manual staleness updates needed. The pipeline DAG and the felt DAG share a single source of truth.

**Wildcards.** Rules with wildcards produce one evidence.json per wildcard combination. The tapestry matches on specName (the `tapestry:` tag suffix), which is fixed per fiber. Options: (a) one fiber per wildcard value (`tapestry:cosebis_nside512`), or (b) an aggregate rule that combines evidence from all combinations into a single summary `evidence.json`.

**`localrules`.** Evidence-writing is typically not localrule — the script is doing real computation. But if you have a lightweight aggregation step that just writes summary evidence.json from completed per-wildcard results, mark it `localrule` to avoid cluster submission overhead.
