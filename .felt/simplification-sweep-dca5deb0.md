---
title: Simplification sweep
status: open
tags:
    - '[portolan]'
created-at: 2026-03-06T10:46:31.715433+01:00
---

Deep simplification of the portolan codebase. Not a checklist — a desired state. Survey reality, find the largest gap, close it.

## Desired State

Every source file owns one concern. You can describe what a file does in one sentence without conjunctions. No file exceeds 800 LOC — not because of an arbitrary limit, but because a single concern rarely needs more than that. When a file has section headers (`// === X ===`), those sections have become their own modules.

Dead code is gone. Redundant abstractions are collapsed. Names say what they mean. The codebase does exactly what it does now, with fewer lines and clearer structure.

## Scope

Everything is in scope: extracting modules, splitting classes, moving functions, consolidating duplication, renaming, removing dead code. Observable behavior must not change.

## Principles

**Do the hard work.** The small files are already clean. What remains is structural — understanding how large files decompose along natural seams. This requires reading, mapping internal structure, and making judgment calls about what belongs together.

**"Well-organized despite its size" is not clean.** Section headers inside a file are evidence that the file contains multiple concerns. They are the seams along which to extract.

**Run /simplify, don't just read.** Invoke the skill and let it analyze. Your judgment plus /simplify's analysis is stronger than either alone.

**One concern per iteration.** Don't try to simplify the whole codebase in one pass. Pick the file with the most to gain, understand it deeply, restructure it, verify, commit. Then survey again with fresh eyes.

## Method

Each iteration:

1. **Survey.** Find source files that violate the desired state. `find src server/src -name '*.ts' -o -name '*.js' | xargs wc -l | sort -rn` shows the largest. Read section headers to understand internal structure. Pick the one with the most to gain.
2. **Read completely.** Map the file's concerns — what are the distinct responsibilities? What would you name each section if it were its own module?
3. **Invoke `/simplify`** on the file. Follow its analysis.
4. **Extract.** Create new modules for distinct concerns. Update all imports across the codebase (`grep -r 'from.*oldfile' src/ server/src/`). The original file should become a thin coordinator or disappear entirely.
5. **Verify.** `cd server && npm test` for server changes. `npm run build` for frontend. Both must pass.
6. **Commit** with `simplify: <what you did>`.
7. **Update this fiber** — add a brief note to the log below describing what you found and what you did. This is how the next iteration orients.

## Evidence

```bash
find src server/src -name '*.ts' -o -name '*.js' | xargs wc -l | sort -rn | head -20
cd server && npm test
npm run build
```

When no file exceeds ~800 LOC and the largest files each own a single describable concern, the sweep is done.

## Context

The codebase is ~21k LOC across ~40 source files. Files under 500 LOC have been reviewed and are clean. The structural work is in the large files. Key areas of complexity:

- **Server:** `HttpApi.ts` has 49 methods across 13+ endpoints with section headers. `index.ts` mixes WS dispatch, search, and directory browsing.
- **Frontend UI:** `TapestryView.ts` (3.2k) combines D3 force simulation, fiber detail editing, claims sidebar, and wave reveal animation. `FileViewerModal.ts` (2.3k) combines CodeMirror, PDF rendering, image lightbox, and annotation toolbar.
- **Render:** `ZoneRenderer.ts` (1.4k) handles hex meshes, city sprites, labels, drag state, and tooltips.
- **Entry:** `main.ts` (1.3k) wires Three.js setup, WebSocket connection, render loop, and event dispatch.

## Log

**Iteration 4 (2026-03-06):** Surveyed all files. TapestryView.ts (3226 LOC) is the largest by far with 13 section headers. Extracted types to `tapestry-types.ts` (91 LOC) and pure helper functions (geometry, staleness, text formatting, neighbor analysis) to `tapestry-helpers.ts` (160 LOC). TapestryView.ts now 2987 LOC. Next targets: the class still has ~10 distinct concerns behind section headers. The biggest remaining extraction opportunities are annotations (~300 LOC), lightbox (~110 LOC), inline markdown editing (~165 LOC), and the static file modal. FileViewerModal.ts (2287) and HttpApi.ts (2004) are the next-largest files.

**Iteration 5 (2026-03-06):** Stayed on `TapestryView.ts` and extracted two embedded UI subsystems: the static export file viewer to `TapestryStaticFileModal.ts` (167 LOC) and artifact lightbox navigation/annotation to `TapestryArtifactLightbox.ts` (146 LOC). `TapestryView.ts` dropped to 2743 LOC and now delegates those concerns instead of owning their DOM/event lifecycles inline. Verified with `npm run build`. Next seams in the file are the inline markdown editor and the claims annotation workflow; after that, `FileViewerModal.ts` and `HttpApi.ts` remain the largest structural targets.

**Iteration 6 (2026-03-06):** Stayed on `TapestryView.ts` because the inline markdown body editor was still a self-contained subsystem embedded in the class. Extracted rendered-body and CodeMirror edit/save lifecycle into `TapestryDetailBody.ts` (166 LOC), including markdown rendering, inline path wiring, dirty tracking, and fiber file persistence. `TapestryView.ts` dropped to 2619 LOC and now coordinates body editing instead of owning editor construction and save logic directly. Verified with `npm run build`. Next seams are the claims annotation workflow inside `TapestryView.ts`, then `FileViewerModal.ts` and `HttpApi.ts`.

**Iteration 7 (2026-03-10):** Stayed on `TapestryView.ts` and extracted the claims annotation subsystem to `TapestryClaimsAnnotations.ts` (379 LOC). The new module now owns annotation panel wiring, popover UI, claims persistence, worker handoff, and file-as-fiber actions; `TapestryView.ts` dropped to 2276 LOC and now only forwards selection and image-pin events into that controller. Verified with `npm run build`. Next seams in `TapestryView.ts` are the remaining detail/sidebar coordination and DAG interaction logic; after that, `FileViewerModal.ts` and `HttpApi.ts` remain the largest structural targets.

**Iteration 8 (2026-03-10):** Shifted to `FileViewerModal.ts`, which was still mixing modal shell, file viewing, editor lifecycle, rendered-markdown selection, image pinning, annotation persistence, worker dispatch, and file-as-fiber actions. Extracted the annotation application to `FileViewerAnnotations.ts` (799 LOC), including CodeMirror highlight state, annotation panel wiring, text selection toolbars, image annotation popovers, worker handoff, and filing feedback as fibers. `FileViewerModal.ts` dropped from 2287 LOC to 1421 LOC and now focuses on loading files plus coordinating editor/rendered/PDF/image presentation. Verified with `npm run build`. Next structural seams are the remaining rendered-markdown/fiber rendering logic inside `FileViewerModal.ts`, then `HttpApi.ts`, `server/src/index.ts`, `ZoneRenderer.ts`, and `main.ts`.
