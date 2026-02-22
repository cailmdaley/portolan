---
title: 'Pyramid tapestry: tiered navigation with section fold-points'
status: open
tags:
    - portolan
    - spec
created-at: 2026-02-21T14:24:07.308205+01:00
---

## Vocabulary

See fiber `vocabulary-c735cd73` (Vocabulary) in the portolan tapestry for the canonical definitions. Short version: **fibers** are atomic concerns; **felt** is the rhizomatic substrate (Deleuzian smooth space); **tapestry** is the visualization where meaning-making happens; **sections** (tier:1) are waypoints not categories. **Fog** is the state of unrevealed nodes: present but not legible, like stitchwork too fine to see from a distance.

## Nature of this Constitution

**Partner-shaping**, not autonomous. The user guides direction, tests, and decides between iterations. The constitution is a living document — it reflects what we've learned, not a log of what we've done.

## Desired State

The tapestry reads like a manuscript at two scales. Stand back: you see the skeleton — a sparse graph of sections, each labeled with its shape and fiber count. Step forward: you see the stitchwork — interior fibers emerge from the fog, connected to their section and to each other. You never feel lost because sections are always visible as anchors and each click reveals where you stand.

A reader enters, sees the shape of the argument at a glance, then drills into the region they care about. Each click is a step through the graph. Each step is reversible. The fog holds everything; revelation is the interaction.

### Done conditions

- First load renders only section nodes and the edges between them ✓
- Each section node shows a staleness dot strip (neighbor count + freshness) ✓
- Clicking any node reveals its 1-hop neighborhood from fog ✓
- Clicking a revealed neighbor reveals ITS neighbors ✓
- Clicking background collapses all to skeleton ✓
- Reveal animation: radial wave from nearest section ancestor ✓
- Search input matches all fibers; clicking a result reveals it from fog ✓
- URL fragments (`#fiber-id`) work — opening a URL auto-expands the containing section ✓
- Static export carries tiering metadata; static mode has the same drill-down behavior (to verify)
- Existing features (staleness coloring, detail panel, annotation, body editing, artifact lightbox) work unchanged within expanded sections ✓

### What "section" means

Section nodes are ordinary fibers with a `tier:1` tag. That's it. They behave identically to every other fiber — same hover, same click-to-sidebar, same detail panel, same body editing. The ONLY difference: they're visible in skeleton view, they render slightly larger with a staleness dot strip, and they anchor the column layout for interior nodes.

Sections are modeled on paper sections — Introduction, Data, Methods, Results, Discussion, Conclusion. This familiar framework gives the reader an immediate mental model: they know roughly what each region contains before clicking. The structure isn't rigid — a tapestry doesn't have to follow this template — but the analogy grounds the concept.

A fiber belongs to a section's neighborhood if it is **1 hop** from the section node (direct upstream or downstream dependency). Fibers reachable from multiple sections appear when any parent section is expanded. Sections link to each other in the DAG (Data → Methods → Results) — they're waypoints, not buckets.

### Interaction model (uniform for all nodes)

| Action | Behavior |
|--------|----------|
| **Hover any node (300ms)** | Full radial reveal animation + tooltip (body lead ÷ outcome). Collapses on mouseleave. |
| **Click any node** | Sidebar shows full detail. 1-hop neighborhood emerges from fog. Expansion permanent. |
| **Click again** | Node collapses — neighborhood returns to fog. |
| **Click background** | Sidebar closes. Map returns to skeleton (sections only). |
| **Click while hovering** | Makes hover-expansion permanent — mouseleave won't collapse. |

Every click reshapes what's visible. The fog holds everything; sections are the trailheads you navigate relative to. Each click is a step. Each step is reversible.

Hover is the scout (300ms threshold filters accidental passes). Click is the commitment. Sections aren't a special class — they're fibers that happen to be visible on first load.

### Three zoom levels (pyramid summaries)

Inspired by [Factory's pyramid summaries](https://factory.strongdm.ai/techniques/pyramid-summaries): survey at the compressed level, expand only what's interesting. Not a rigid 2-4-8-16 word doubling — the natural levels emerge from existing fiber structure:

| Level | What you see | Source |
|-------|-------------|--------|
| **Label** (2-3 words) | Node in DAG | `shortName(fiber.title)` |
| **Lead paragraph** (1-2 sentences) | Hover tooltip (300ms) | First sentences of fiber body + outcome ✓ |
| **Full detail** | Sidebar panel | Body, outcome, evidence, artifacts |

These levels apply to ALL nodes, not just sections. The section body happens to serve as a summary of its neighborhood — but that's a content convention, not a rendering distinction.

### Scope

Everything is on the table. This may touch rendering, server endpoints, fiber conventions, snakemake scripts, the tapestry skill — whatever produces the best result. The only invariant is that existing features (staleness, detail panel, annotation, editing, lightbox) continue to work within expanded sections.

## Design principles discovered through building

**Fog = presence, not absence.** The tapestry contains everything. Navigation is revelation, not navigation between pages. Nothing is ever "gone" — only "not yet seen." The fog is the substrate. Nodes in fog render at 0.09 opacity with blur filter, and remain clickable.

**Every click is a step.** The interaction model is uniform — section or interior, revealed or fogged. Click → reveal 1-hop neighborhood. Click again → collapse. Click background → skeleton. No special cases, no modal states.

**Interior nodes branch vertically.** Sections have pinned X (columns); interior nodes have their X snapped to their nearest section parent's column, then released — the force simulation pulls them into the column while charge spreads them vertically. Expanding a section restarts simulation at low alpha to settle newly visible nodes.

**Animation carries meaning.** The radial reveal wave isn't decoration — it's the "unfolding" of the tapestry. The wave originates from the nearest section ancestor (BFS upstream), so the animation conveys structural provenance. Edge drag-inertia (sagPos lerp) makes the graph feel physical: edges sag when held, spring back on release.

**Sections are waypoints.** A section is just a fiber with `tier:1` — same sidebar, same detail panel, same editing. The only distinction is visibility at load and the column-anchor role in layout. The Bayeux tapestry analogy: sections are scenes; interior fibers are stitchwork. You stand back to see scene composition; step close to see detail.

## Content Conventions

These aren't schema changes — they're patterns that make the tapestry more useful. Encourage but don't enforce.

- **Paper provenance.** Download arXiv `.tex` source to `results/references/`. Fiber outcomes cite specific lines: `results/references/smith2024.tex:L42-55`. The tapestry renders these as clickable links. Most of ASP's evidence system for almost nothing.
- **Decision alternatives.** Decision fibers (`kind: decision`) note what was considered, not just what was chosen. "Chose X because Y; also considered A (too slow) and B (wrong assumptions)." Makes the DAG auditable.
- **Edge annotations.** `depends_on` edges can carry text explaining *why* the dependency exists. Convention exists in felt but is underused — the tapestry could render edge labels on hover.

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
| `vite.static.config.ts` | Static build config (base path, output dir) |

### Architectural pattern

d3-force simulation runs on ALL nodes at load. Burn-in phase (800 ticks) computes positions. Section nodes get `fx` pinned (columns). Interior nodes have `x` snapped to their section parent's column, then `fx` left undefined. After burn-in, `updateTierVisibility()` sets fog/reveal state. Expanding calls `updateTierVisibility(animate=true)` + restarts simulation at alpha 0.05.

`expandedNodes: Set<string>` tracks which nodes have been clicked open. `visibleNodes: Set<string>` tracks which are fully visible — guards `updateHighlighting()` from overriding fog opacity. `revealAndSelect(id, animate?)` is the entry point for programmatic navigation (URL hash, search): adds to `expandedNodes`, calls `updateTierVisibility`, then `selectNode`.

### Key functions

| Function | Purpose |
|----------|---------|
| `updateTierVisibility(animate?, center?)` | Recomputes visible set; triggers reveal/collapse waves |
| `revealNodesRadial(center, newlyVisible)` | Expanding ring animation from nearest section ancestor |
| `collapseNodesRadial(center, becomingFog)` | Contracting ring animation |
| `revealAndSelect(id, animate?)` | Programmatic entry: expand fog, then select |
| `selectNode(id)` | Updates highlighting, detail panel, hash |
| `selectFromHash()` | Called on load; uses revealAndSelect |

## Skills

- `/tapestry` — for understanding evidence and rendering conventions
- Frontend work — iterations should use `--chrome` flag

## Test Tapestry

11 fibers in portolan `.felt/` tagged `tapestry:portolan`. 5 tier:1 sections (Introduction, Structure, Rendering, Interaction, Evidence). 6 interior fibers (Fiber anatomy, Dependency semantics, Staleness computation, Force-directed layout, Organic shapes, URL fragments). Serves as test fixture, tutorial, and example simultaneously.

## Open Questions

- **Static export tiering**: Verify that tier:1 tag passes through to static JSON and tiered behavior works in static mode.
