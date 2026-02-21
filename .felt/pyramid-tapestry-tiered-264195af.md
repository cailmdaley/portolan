---
title: 'Pyramid tapestry: tiered navigation with section fold-points'
status: open
tags:
    - portolan
    - spec
created-at: 2026-02-21T14:24:07.308205+01:00
---

## Vocabulary

See fiber `vocabulary-c735cd73` (Vocabulary) in the portolan tapestry for the canonical definitions. Short version: **fibers** are atomic concerns; **felt** is the rhizomatic substrate (Deleuzian smooth space); **tapestry** is the visualization where meaning-making happens; **sections** (tier:1) are waypoints not categories; **warp trace** is the gold path from any selected node back to its nearest section anchor.

## Nature of this Constitution

This is a **partner-shaping** constitution, not an autonomous loop. The user is actively guiding direction, testing, and making decisions between iterations. The constitution itself is a living document — iterations should modify it as decisions are made and the design clarifies. What's written here is the starting sketch; what it becomes is the outcome of the collaboration.

## Desired State

The tapestry reads like a map at two scales. On first load you see the **skeleton**: 4-8 section nodes connected by dependency edges, each showing a count of the fibers inside. Click a section and it opens — its internal nodes appear in a local DAG neighborhood, connected to each other and to the section. Non-active sections fade into fog but remain visible as anchors. At any depth, a **warp trace** — the structural thread — marks the shortest path back to the nearest section. Search finds any fiber regardless of visibility — matching nodes emerge from the fog.

A reader enters the tapestry, sees the shape of the analysis at a glance, then drills into the region they care about. They never see more than ~10 nodes at once. They're never lost.

### Done conditions

- First load renders only section nodes and the edges between them
- Each section node shows a count indicator (e.g., "5 fibers")
- Clicking a section reveals its internal nodes in-place, with edges
- Clicking elsewhere (another section, background) collapses the currently expanded section
- Warp trace drawn as a highlighted path from any selected node back to the nearest section
- Search input in sidebar matches all fibers; matches inside collapsed sections emerge from the fog
- URL fragments (`#fiber-id`) work across both collapsed and expanded states — opening a URL auto-expands the containing section
- Static export carries tiering metadata; static mode has the same drill-down behavior
- Existing features (staleness coloring, detail panel, annotation, body editing, artifact lightbox) work unchanged within expanded sections

### What "section" means

Section nodes are ordinary fibers with a `tier:1` tag. That's it. They behave identically to every other fiber — same hover, same click-to-sidebar, same detail panel, same body editing. The ONLY difference: they're visible in skeleton view, they render slightly larger with a count indicator, and clicking them expands their 1-hop neighborhood.

Sections are modeled on paper sections — Introduction, Data, Methods, Results, Discussion, Conclusion. This familiar framework gives the reader an immediate mental model: they know roughly what each region contains before clicking. The structure isn't rigid — a tapestry doesn't have to follow this template — but the analogy grounds the concept.

A fiber belongs to a section's neighborhood if it is **1 hop** from the section node (direct upstream or downstream dependency). Fibers reachable from multiple sections appear when any parent section is expanded. Sections link to each other in the DAG (Data → Methods → Results) — they're waypoints, not buckets.

### Interaction model (uniform for all nodes)

| Action | Behavior |
|--------|----------|
| **Hover any node** | Tooltip with lead paragraph (first 1-2 sentences of body) |
| **Click any node** | Sidebar shows full detail. Map shows that node's 1-hop neighbors + warp trace back to nearest section. |
| **Click background** | Sidebar closes. Map returns to skeleton (sections only). |

Every click reshapes what's visible. Click a section → see its direct neighbors. Click one of those → see ITS neighbors, plus the trail back to the section. Each click is a step through the graph. Sections are the trailheads — the starting view and the anchors you navigate relative to.

Hover is the scout. Click is the commitment. Sections aren't a special class — they're fibers that happen to be visible on first load.

### Three zoom levels (pyramid summaries)

Inspired by [Factory's pyramid summaries](https://factory.strongdm.ai/techniques/pyramid-summaries): survey at the compressed level, expand only what's interesting. Not a rigid 2-4-8-16 word doubling — the natural levels emerge from existing fiber structure:

| Level | What you see | Source |
|-------|-------------|--------|
| **Label** (2-3 words) | Node in DAG | `shortName(fiber.title)` |
| **Lead paragraph** (1-2 sentences) | Hover tooltip | First sentences of fiber body |
| **Full detail** | Sidebar panel | Body, outcome, evidence, artifacts |

These levels apply to ALL nodes, not just sections. The section body happens to serve as a summary of its neighborhood — but that's a content convention, not a rendering distinction.

### Scope

Everything is on the table. This may touch rendering, server endpoints, fiber conventions, snakemake scripts, the tapestry skill — whatever produces the best result. The only invariant is that existing features (staleness, detail panel, annotation, editing, lightbox) continue to work within expanded sections.

## Context

### Key files

| File | Role |
|------|------|
| `src/ui/TapestryView.ts` | DAG rendering, node selection, detail panel, all interactions (~2200 LOC) |
| `src/ui/utils.ts` | Shared rendering utilities (markdown, staleness colors, artifact gallery) |
| `server/src/HttpApi.ts` | `/tapestry` endpoint — builds TapestryResponse from fibers + evidence |
| `server/src/FiberReader.ts` | Parses `.felt/*.md` fibers, extracts metadata |
| `scripts/export-tapestry.ts` | Static export: fetches `/tapestry`, downloads artifacts, writes JSON |
| `src/static/main.ts` | Static mode entry: loads JSON, calls `showStatic()` |
| `vite.static.config.ts` | Static build config (base path, output dir) |

### Existing mechanisms to build on

- **`depthMap`** in `renderDAG()` already computes DAG depth from dependencies. Section detection can use this or be overridden by the `tier:1` tag.
- **`updateHighlighting()`** already dims non-connected nodes to opacity 0.3. The expand/collapse model extends this: collapsed nodes have opacity 0 (hidden), section nodes always visible.
- **`selectNode()` → `pushHash()`** already handles URL fragments. Needs extension: if the target node is in fog, reveal its neighborhood + warp trace first.
- **`selectFromHash()`** already auto-selects on load. Same extension needed.
- **Sidebar search** already filters and highlights matching DAG nodes (`.search-match`). Needs extension: matches in fog should emerge — how exactly is TBD.
- **`TapestryNode.tags`** already carries tag arrays. The `tier:1` tag is just a filter.

### Architectural pattern

The rendering is d3-force with a burn-in phase (800 ticks) that computes positions, then pins X. Nodes are SVG `<g>` groups with organic ellipses. The simulation continues running (for Y settling) after burn-in.

For tiered rendering, the approach is:
1. Run the simulation on ALL nodes (including hidden ones) — positions are stable
2. After burn-in, set visibility based on which sections are expanded
3. Expand/collapse toggles SVG visibility + adjusts edges, without re-running the simulation
4. Section nodes render larger (1.5-2× radius) with the count indicator as secondary text

This means the full layout is pre-computed. Expanding a section reveals nodes at positions the simulation already determined. No layout recomputation on interaction.

## Skills

- `/tapestry` — for understanding evidence and rendering conventions
- Frontend work — iterations should use `--chrome` flag

## Test Tapestry

Existing tapestries (`cmbx`, `pure_eb`) don't have `tier:1` nodes. Rather than retrofitting, build a self-referential test tapestry: **a tapestry explaining how tapestries work**. ~10 nodes, a few `tier:1` sections, realistic dependency structure. It serves as test fixture, tutorial, and example simultaneously.

An early iteration should explore and design this — choose the node structure, create the fibers, wire the dependencies. The tapestry should be interesting enough to be worth reading on its own.

## Evidence

Progress is visible by inspection:

```bash
# Does skeleton view load with only tier:1 nodes?
# Open the test tapestry and count visible nodes on first render.

# Does click-to-expand work?
# Click a section → its 1-hop neighbors appear. Click a neighbor → ITS neighbors appear + warp trace back.

# Does fog work?
# Non-active sections fade. Search matches emerge from fog.

# Does URL fragment navigate correctly?
# Open a URL with #deep-fiber-id → correct section context shown, node selected.
```

## Content Conventions

These aren't schema changes — they're patterns that make the tapestry more useful. Encourage but don't enforce.

- **Paper provenance.** Download arXiv `.tex` source to `results/references/`. Fiber outcomes cite specific lines: `results/references/smith2024.tex:L42-55`. The tapestry renders these as clickable links. Most of ASP's evidence system for almost nothing.
- **Decision alternatives.** Decision fibers (`kind: decision`) note what was considered, not just what was chosen. "Chose X because Y; also considered A (too slow) and B (wrong assumptions)." Makes the DAG auditable.
- **Edge annotations.** `depends_on` edges can carry text explaining *why* the dependency exists. Convention exists in felt but is underused — the tapestry could render edge labels on hover.

## Open Questions

- **Animation**: expand/collapse could animate or snap instantly. Defer — get the mechanics right first, polish later.
- **Search emergence**: how exactly do matches "emerge from the fog"? Visual treatment TBD.
- **Multi-section membership**: fibers reachable from multiple sections appear when any parent is active. Details TBD.
