---
title: Fibers
status: open
tags:
    - tapestry:portolan-fibers
    - tapestry:portolan
depends-on:
    - the-tapestry
    - felt
created-at: 2026-02-21T17:17:55.808352+01:00
outcome: 'A fiber earns its name by being one thing: body for context, outcome for conclusion, edges for accountability — the smallest unit that can carry both what happened and why it mattered. The DAG turns outcomes into a causal record: walk upstream from any decision and you reconstruct the reasoning that produced it.'
---

(fibers)=
A fiber is not a note. A note is a container for information. A fiber is a commitment to one concern — a question, a decision, a task — that has a beginning, a resolution, and a place in a larger structure. That structure is a directed acyclic graph: fibers depend on other fibers, and those dependencies carry meaning. If A depends on B, it means A's reasoning rests on B's outcome. The graph is not organizational; it is causal.

A fiber is an atomic concern. Not a task, not a note, not a ticket — though it can be any of those. What makes it a fiber is the commitment to closure: every fiber has a body and an outcome. The body is the space of investigation. The outcome is the crystallization — what you learned, what you decided, why. Without an outcome, a fiber is open; with one, it carries meaning forward into whatever depends on it.

The outcome field is where this becomes useful. When you close a fiber, the outcome records not just what happened but why — what alternatives were weighed, what failed, what the deciding factor was. A downstream fiber needing context walks the DAG and reads upstream outcomes in sequence. No transcript search. No archaeology. The reasoning is already there, threaded through the structure.

Fibers resist the impulse to grow. A fiber that touches three concerns should be three fibers with dependency edges between them. The cost of a fiber is nearly zero; the cost of entanglement is high. A one-sentence decision is a fiber. Uncertainty is a fiber. A detour you can't pursue now is a fiber — filed, not forgotten, not blocking anything, but present in the graph for whoever comes next.

The body holds what you knew when you filed it. The outcome holds what you know when you close it. The edges hold the causal chain. Together they form a unit that can be understood in isolation, navigated in context, and composed into larger structures without losing coherence.

Fibers are plain markdown files in `.felt/` with YAML frontmatter. The `felt` CLI manages them: `felt "Research X"` opens one, `felt edit <id> -s closed -o "..."` closes it with an outcome. A fiber worth closing is worth filing; even a one-sentence decision leaves a node the DAG can point to. This tapestry has 19 fibers, 3 sections, and 26 dependency edges — a small graph, but every edge represents a real dependency in how the system was built.

The nodes ahead explore this from different angles: anatomy, lifecycle, felt concept, fog, outcomes, sections, and conventions. Each is a lens on the same underlying structure — fibers as the atomic unit of recorded reasoning.
