---
title: 'Pyramid tapestry: tiered navigation with section fold-points'
status: open
tags:
    - portolan
    - spec
created-at: 2026-02-21T14:24:07.308205+01:00
---

## Vocabulary

**Fibers** are atomic concerns. **Sections** (tier:1) are waypoints, not categories. **Warp trace** is the gold path from any selected node back to its nearest section anchor — the structural thread in weaving that runs the length of the fabric. **Fog** is the state of unrevealed nodes: present but not legible, like stitchwork too fine to see from a distance.

## Nature of this Constitution

**Partner-shaping**, not autonomous. The user guides direction, tests, and decides between iterations. The constitution is a living document — it reflects what we've learned, not a log of what we've done.

## Desired State

The tapestry reads like a manuscript at two scales. Stand back: you see the skeleton — a sparse graph of sections, each labeled with its shape and fiber count. Step forward: you see the stitchwork — interior fibers emerge from the fog, connected to their section and to each other. You never feel lost because sections are always visible as anchors and the warp trace shows where you stand.

A reader enters, sees the shape of the argument at a glance, then drills into the region they care about. Each click is a step through the graph. Each step is reversible. The fog holds everything; revelation is the interaction.

### What's built

- Skeleton view: only tier:1 nodes visible at load, connected by DAG edges
- Section nodes: 1.5× larger, dot strip showing neighbor staleness (colored ●/○)
- Click any node: 1-hop neighborhood emerges from fog, warp trace highlighted gold
- Fog: nodes render at 0.09 opacity with blur filter — present but not legible, always clickable
- Reveal animation: radial wave from nearest section ancestor; nodes fade in as ring passes
- Collapse animation: reverse wave returns nodes to fog
- Edge physics: bezier curves with drag-only inertia (sagPos lerps while held, snaps on release)
- Ink palette: per-node color from seeded hash (verdigris/iron-gall/slate)
- Interior nodes: float vertically in their section's column; simulation restarts at alpha 0.05 on expand
- Warp trace: BFS upstream to nearest tier:1 node, edges highlighted gold
- Test tapestry: 11 fibers, 5 sections — portolan self-reference (Introduction, Structure, Rendering, Interaction, Evidence)

### What remains

- **URL fragments**: `selectFromHash()` calls `selectNode()` directly, but if the target is in fog, it stays invisible. Need to first auto-expand the containing section, then select.
- **Search emergence**: Fog nodes that match search show `.search-match` class but are invisible. Clicking a result calls `selectNode()` which reveals them — but the highlight is unsatisfying. Need: reveal matched nodes softly even before click (pulse? glow? transient opacity lift?).
- **Static export**: Verify that tier:1 tag passes through to static JSON and that static mode respects tiering.

### Design principles discovered through building

**Fog = presence, not absence.** The tapestry contains everything. Navigation is revelation, not navigation between pages. This changes the semantics: nothing is ever "gone," only "not yet seen." The fog is the substrate.

**Every click is a step.** The interaction model is uniform across all nodes — section or interior, revealed or fogged. Click → reveal neighborhood + warp trace. Click again → collapse. Click background → skeleton. No special cases.

**Interior nodes branch vertically.** Sections have pinned X (columns); interior nodes have their X snapped to their nearest section parent's X, then released — the simulation pulls them into the column while charge force spreads them vertically. Expanding a section restarts simulation at low alpha to settle newly visible nodes.

**Animation carries meaning.** The radial reveal wave isn't decoration — it's the "unfolding" of the tapestry. The wave origin is the nearest section ancestor (not the clicked node), so the animation conveys the structural relationship. Edge drag-inertia makes the graph feel physical.

**Sections are waypoints.** A section is just a fiber with `tier:1` — same sidebar, same detail panel, same editing. The only distinction is visibility at load and the column-anchor role in layout.

## Context

### Key files

| File | Role |
|------|------|
| `src/ui/TapestryView.ts` | DAG rendering, node selection, fog/reveal, all interactions (~2700 LOC) |
| `src/ui/utils.ts` | Shared rendering utilities (markdown, staleness colors, artifact gallery) |
| `server/src/HttpApi.ts` | `/tapestry` endpoint — builds TapestryResponse from fibers + evidence |
| `server/src/FiberReader.ts` | Parses `.felt/*.md` fibers, extracts metadata |
| `scripts/export-tapestry.ts` | Static export: fetches `/tapestry`, downloads artifacts, writes JSON |
| `src/static/main.ts` | Static mode entry: loads JSON, calls `showStatic()` |

### Architectural pattern

d3-force simulation runs on ALL nodes at load. Burn-in phase (800 ticks) computes positions. Section nodes get fx pinned after burn-in. Interior nodes have x snapped to their section parent's column, then fx left undefined. After burn-in, `updateTierVisibility()` sets fog/reveal state. Expanding a section calls `updateTierVisibility(animate=true)` + restarts simulation at alpha 0.05.

`expandedNodes: Set<string>` tracks which nodes have been clicked. `visibleNodes: Set<string>` tracks which nodes are fully visible. `visibleNodes` guards `updateHighlighting()` and `collapseNodesRadial()` from overriding fog opacity.

### Key functions

| Function | Purpose |
|----------|---------|
| `updateTierVisibility(animate?, center?)` | Recomputes visible set; triggers reveal/collapse waves |
| `revealNodesRadial(center, newlyVisible)` | Expanding ring animation from section ancestor |
| `collapseNodesRadial(center, becomingFog)` | Contracting ring animation |
| `computeWarpTrace(nodeId)` | BFS upstream to nearest tier:1; returns {nodes, edges} |
| `selectNode(id)` | Updates highlighting, detail panel, hash, calls updateTierVisibility |
| `selectFromHash()` | Called on load; needs auto-expand for fog nodes (TODO) |

## Skills

- `/tapestry` — for understanding evidence and rendering conventions
- Frontend work — iterations should use `--chrome` flag

