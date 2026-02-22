---
title: Fibers
status: open
tags:
    - tapestry:portolan-fibers
    - tapestry:portolan
    - tier:1
depends-on:
    - tapestry-introduction-537a6234
created-at: 2026-02-21T17:17:55.808352+01:00
outcome: A fiber's outcome is not a summary — it is evidence. The DAG turns outcomes into a causal record: walk upstream from any decision and you reconstruct the reasoning that produced it.
---

A fiber is not a note. A note is a container for information. A fiber is a commitment to one concern — a question, a decision, a task — that has a beginning, a resolution, and a place in a larger structure. That structure is a directed acyclic graph: fibers depend on other fibers, and those dependencies carry meaning. If A depends on B, it means A's reasoning rests on B's outcome. The graph is not organizational; it is causal.

The outcome field is where this becomes useful. When you close a fiber, the outcome records not just what happened but why — what alternatives were weighed, what failed, what the deciding factor was. A downstream fiber needing context walks the DAG and reads upstream outcomes in sequence. No transcript search. No archaeology. The reasoning is already there, threaded through the structure.

Fibers are plain markdown files in `.felt/` with YAML frontmatter. The `felt` CLI manages them: `felt "Research X"` opens one, `felt edit <id> -s closed -o "..."` closes it with an outcome. A fiber worth closing is worth filing; even a one-sentence decision leaves a node the DAG can point to. This tapestry has 21 fibers, 5 sections, and 19 dependency edges — a small graph, but every edge represents a real dependency in how the system was built.
