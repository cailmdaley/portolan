---
title: Vocabulary
tags:
    - tapestry:portolan
depends-on:
    - tapestry-introduction-537a6234
created-at: 2026-02-21T20:06:16.373088+01:00
outcome: 'Four terms: fibers (atomic concerns), felt (the substrate), tapestry (the visualization), sections (waypoints). Philosophically Deleuzian — smooth space that accepts temporary structure for legibility without being organized by it.'
---

**Fibers** are the atomic unit — individual concerns: tasks, decisions, questions, specs, observations. A fiber can be a one-sentence decision or a multi-paragraph investigation. Fibers connect to each other via dependency edges, forming a directed acyclic graph. The direction encodes meaning: A depends on B means B is a prerequisite or foundation for A. The body holds context; the outcome holds the conclusion.

**Felt** is what you get when fibers accumulate. In material terms, felt is a non-woven textile — fibers compressed together with no fixed orientation, no privileged axis, no warp or weft. This is intentional: the metaphor is Deleuzian. The felt is smooth space, rhizomatic, connecting any point to any other point without predetermined hierarchy. It resists the arborescent impulse to organize everything into trees. The DAG structure that emerges is a property of the dependencies you file, not a schema imposed from outside.

**Tapestry** is the visualization of the felt, produced for a specific city (project directory). It renders the fiber graph as a force-directed DAG — nodes for fibers, edges for dependencies, staleness encoded in color. The tapestry is where meaning-making happens: you can see the shape of an analysis at a glance, drill into regions, trace how conclusions depend on evidence. It imposes temporary structure on the smooth space of the felt — useful for inspection and communication, without claiming to be the final word on how the fibers relate.

**Sections** (fibers tagged `tier:1`) are waypoints in the tapestry, not categories. They appear on first load as the skeleton of the analysis. They're modeled loosely on paper sections — Introduction, Methods, Results — but the metaphor isn't mandatory. What matters is that sections are visible anchors you navigate relative to. Clicking a section reveals its immediate neighborhood; sections link to each other in the DAG as the spine of the analysis. They're the one concession to tree-thinking in an otherwise rhizomatic system.

