---
title: 'Absorb claims dashboard into portolan: native DAG view'
status: closed
created-at: 2026-02-08T16:17:17.619968+01:00
closed-at: 2026-02-09T03:19:58.319596+01:00
---

(absorb-claims-dashboard-into)=
This is your spec for a Ralph loop, a meditative iteration toward a desired state.

## Desired State

The D3 DAG visualization that was in the conducting-research skill is now a native portolan component — `RhizomeView.ts`. No iframe, no postMessage bridge, no injected scripts. Annotations are native DOM events.

### What RhizomeView does

Full-page overlay (same pattern as current ClaimsDashboard — hides hex map). Shows:

1. **D3 DAG** — force-directed layout of fibers tagged with `rule:`. Organic node shapes (ellipses with concentric rings, procedural noise). Curved edges from dependency graph. Search across fibers.

2. **Staleness coloring** — teal if evidence mtime >= all upstream dependencies' mtime. Red if stale (older than at least one upstream). Muted gray if no evidence yet.

3. **Fiber detail panel** — slides in from right on node click. Layout top-to-bottom:
   - Title + status badge + staleness indicator
   - Primary artifact plot (clickable for lightbox)
   - Fiber body (rendered markdown — description, method, context)
   - Evidence metrics from evidence.json (collapsible, omitted if absent)
   - Downstream concerns (linked task/question fibers)

4. **Native annotation** — text selection on the fiber body triggers annotation popover. Image click in lightbox places pin. AnnotationPanel wired directly. All actions work: CRUD, send to worker, promote to felt.

### What's deleted

- `server/public/claims-annotate.js` (~800 LOC injection script)
- `handleClaimsDashboard` proxy logic in HttpApi (URL rewriting, variable promotion, script injection)
- `/claims-assets` proxy endpoint
- iframe element + postMessage protocol
- Three-kind taxonomy (foundation/claim/synthesis)

### What stays

- AnnotationPanel.ts (shared sidebar component)
- AnnotationPersistence.ts (unified JSON store)
- FileViewerModal.ts (separate concern, own annotation support)
- Annotation CRUD endpoints (POST/GET/PUT/DELETE /annotations)
- Send to worker + promote to felt actions

### Server additions

- **`/rhizome` endpoint** — single call returning full DAG: fibers with `rule:` tags (including body text), dependency edges, evidence summary per fiber (metrics + artifact filenames + mtime), staleness flags (computed server-side).
- **EvidenceReader** — reads `results/claims/{specName}/evidence.json` and mtime. Works local + remote (SSH cat).
- **Evidence artifact serving** — serves PNG/JPG from `results/claims/{specName}/`. Replaces `/claims-assets` proxy.
- FiberReader extended to return body text (currently metadata-only for HUD).

### D3

Tree-shaken via npm: `d3-force`, `d3-selection`, `d3-shape` (~80KB). Imported as ESM, part of Vite build.

### Done when

- RhizomeView renders DAG from fibers + evidence for any city (local + remote)
- Staleness coloring works (teal/red/gray)
- Fiber detail panel: title → plot → body → evidence → downstream
- Text selection and image annotation work natively
- AnnotationPanel wired directly
- All annotation actions work (CRUD, send to worker, promote to felt)
- claims-annotate.js deleted
- Proxy rewriting deleted
- Tests updated (proxy rewrite tests removed, new endpoint tests added)
- Run the `code-simplifier:code-simplifier` agent until no critical or high-priority issues/opportunities for improvement remain

## Context

### Key files — what you're replacing

| File | LOC | Role |
|------|-----|------|
| `src/ui/ClaimsDashboard.ts` | 420 | iframe wrapper + annotation panel — becomes RhizomeView.ts |
| `src/ui/AnnotationPanel.ts` | 415 | Shared sidebar — **keep**, wire directly |
| `src/ui/FileViewerModal.ts` | 1598 | File viewer — **keep**, separate concern |
| `server/public/claims-annotate.js` | 800 | Injected script — **delete** |
| `server/src/AnnotationPersistence.ts` | 327 | JSON store — **keep** |
| `server/src/HttpApi.ts` | 1400+ | REST + proxy — remove proxy, keep CRUD |
| `server/src/__tests__/HttpApi.claims.test.ts` | ~76 tests | Update: drop proxy tests, add /rhizome tests |

### Key files — what you're porting from

| File | Role |
|------|------|
| `~/loom/skills/conducting-research/templates/dashboard/dashboard.js` | D3 DAG viz (1574 LOC) — port to TypeScript |
| `~/loom/skills/conducting-research/templates/dashboard/dashboard.css` | Porch Morning styling (~600 LOC) — adapt |
| `~/loom/skills/conducting-research/templates/dashboard/dashboard.html.j2` | Layout structure — reference only |

### Patterns to follow

- `src/ui/` for component structure — see existing ClaimsDashboard.ts, FileViewerModal.ts
- `server/src/FiberReader.ts` for reading felt data per city (local + SSH)
- `server/src/HttpApi.ts` for endpoint patterns, `shellEscape()`, `execFileAsync` for SSH safety
- AnnotationPanel's generic `<T extends BaseAnnotation>` pattern for wiring
- CSS variables in `index.html` for Porch Morning palette

### Gotchas to watch for

- `gotcha-ssh-double-quote-810f6df9` — use `execFileAsync('ssh', [...])` for all remote reads
- `gotcha-card-header-drag-28ae4165` — if detail panel has drag, call bringToFront directly
- Vite HMR stacks constructor listeners — add/remove dynamically (see ClaimsDashboard pattern)
- `rule:` tag is the sole filter for dashboard fibers (no `spec:` — clean that up if found)

## Skills

- `/rhizomation` — the philosophy this dashboard serves
- `/frontend-design` — for the detail panel and DAG styling
