---
title: Tapestry conventions
tags:
    - tapestry:portolan
depends-on:
    - tapestry-evidence-0b72e4b2
created-at: 2026-02-22T06:23:22+01:00
outcome: "Seven steps: tag fibers (tapestry:<name>), designate tier:1 sections, wire depends_on edges, write section bodies, place evidence.json at results/claims/{specName}/, cite paper sources as results/references/<id>.tex:L42-55, use inline code for file line references."
---

Everything required to make a tapestry functional and useful, in one place.

**1. Tag fibers.** Add `tapestry:<name>` to any fiber that should appear as a DAG node. The tag suffix is the specName — it links the fiber to `results/claims/{specName}/evidence.json` and determines its place in the graph. One fiber per specName.

**2. Designate sections.** Add `tier:1` to 4–8 fibers that serve as structural waypoints — the skeleton a reader sees on first load. Sections link to each other in the DAG; interior fibers belong to a section if they're 1 hop from it.

**3. Wire dependencies.** `felt link <downstream-id> <upstream-id>` writes a `depends_on` edge. Only edges where both endpoints are tapestry-tagged appear in the DAG. Wire sections to each other first, then wire interior fibers to their nearest section.

**4. Write section bodies as summaries.** Three sentences: what this region contains, why it matters, what a reader will find here. The hover tooltip delivers this — hovering is the scout, clicking is the commitment.

**5. Place evidence.** Computational fibers point to `results/claims/{specName}/evidence.json`. Required fields:
- `id` — matches the specName
- `output` — map of names to image filenames (these render as artifacts)
- `evidence` — flat dict of key metrics (strings and numbers only)
- `generated` — ISO timestamp

Without `evidence.json`, the node renders with no-evidence staleness (umber dot). That's fine — it's honest, not broken.

**6. Cite paper sources.** Download `.tex` source to `results/references/<arxiv-id>.tex`. In fiber outcomes, cite as inline code: `results/references/2601.10038.tex:L79`. The tapestry renders this as a clickable link. Accepts `:L42` and `:L42-55` (range).

**7. File line references.** Any inline code matching `path/to/file.ext:L42` becomes a clickable link in the sidebar — opening that file at that line. Use this in outcomes to anchor claims to exact source locations.

For Snakemake workflows, the snakemake conventions fiber maps these steps onto rule structure directly.
