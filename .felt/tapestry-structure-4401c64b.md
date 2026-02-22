---
title: Fibers
status: open
tags:
    - tapestry:portolan
    - tier:1
depends-on:
    - tapestry-introduction-537a6234
created-at: 2026-02-21T17:17:55.808352+01:00
outcome: Fibers are the atoms of felt — one concern each. They connect via dependency edges into a DAG, forming a structure that emerges from the work rather than being imposed on it.
---

Every fiber has a title, a body, and an outcome. The outcome is the most important field: not a status flag but a record of *why*. 'Chose X because Y; also considered A but it was too slow.' When a downstream fiber needs context, walking the DAG to read upstream outcomes reconstructs the full reasoning chain — no transcript-digging required.

Fibers progress through statuses: open (identified), active (being worked), closed (resolved). Closing requires an outcome. The principle is 'do then document': file what you investigated, what you tried, what failed, what worked. The DAG forms behind you as wake. A one-sentence decision is worth filing; the causal chain is what makes the tapestry auditable.

Fibers are plain markdown files in `.felt/` with YAML frontmatter. The `felt` CLI manages them. To enter a tapestry, a fiber needs a `tapestry:` tag (e.g., `tapestry:portolan`). To become a section node, it also needs `tier:1`. Dependency edges come from `depends_on` in frontmatter, set via `felt link <downstream> <upstream>`. Every interior fiber in this tapestry depends directly on one of the five sections — one hop from the skeleton.
