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

**Iteration 9 (2026-03-10):** Stayed on `FileViewerModal.ts` because the rendered-markdown path was still a separate UI subsystem embedded inside the modal. Extracted markdown DOM creation, fiber frontmatter/card rendering, inline path navigation, rendered selection handling, and cancelable tapestry context hydration into `FileViewerMarkdownView.ts` (361 LOC). `FileViewerModal.ts` dropped from 1421 LOC to 1111 LOC and now focuses on modal shell, file loading, editor/image/PDF presentation, and save/refresh/copy/download actions. Verified with `npm run build`. Next structural seams are the remaining editor/file-loading coordination inside `FileViewerModal.ts`, then `HttpApi.ts`, `server/src/index.ts`, `ZoneRenderer.ts`, and `main.ts`.

**Iteration 10 (2026-03-10):** Stayed on `FileViewerModal.ts` because the remaining editable-text workspace was still a distinct subsystem embedded inside the modal shell. Extracted CodeMirror setup, dirty tracking, markdown edit-mode transitions, save/copy/download actions, and text-file state into `FileViewerTextEditor.ts` (429 LOC). `FileViewerModal.ts` dropped from 1111 LOC to 739 LOC and now coordinates request ownership, modal chrome, navigation keys, and image/PDF/text presentation instead of owning the editor internals. Verified with `npm run build`. Next structural seams are the file-loading/request coordination still inside `FileViewerModal.ts`, then `HttpApi.ts`, `server/src/index.ts`, `ZoneRenderer.ts`, and `main.ts`.

**Iteration 11 (2026-03-10):** Shifted to `HttpApi.ts`, which was still mixing route dispatch with the full annotations workflow. Extracted annotation CRUD, recent-annotation queries, worker send/paste formatting, file-as-fiber filing, and felt promotion into `HttpApiAnnotations.ts` (485 LOC). `HttpApi.ts` dropped from 2004 LOC to 1524 LOC and now routes those endpoints into a dedicated controller while keeping file content, tapestry, playground, and hook/session concerns separate. Verified with `cd server && npm test` and `npm run build`. Next structural seams are the remaining endpoint families inside `HttpApi.ts`, then `server/src/index.ts`, `ZoneRenderer.ts`, and `main.ts`.

**Iteration 12 (2026-03-10):** Stayed on `HttpApi.ts` because the file-content subsystem was still a separate concern embedded alongside route dispatch, tapestry building, activation, playground serving, and hook/session diagnostics. Extracted file loading, binary/raw streaming, save-file persistence, MIME mapping, SSH read/write helpers, and language detection into `HttpApiFileContent.ts` (541 LOC). `HttpApi.ts` dropped from 1524 LOC to 986 LOC and now coordinates routing plus tapestry/activation/playground/hook/runtime concerns instead of owning editor file I/O internals. Verified with `cd server && npm test` and `npm run build`. Next structural seams are the remaining endpoint families inside `HttpApi.ts` (especially tapestry vs playground/activation/hook/runtime coordination), then `server/src/index.ts`, `ZoneRenderer.ts`, and `main.ts`.

**Iteration 13 (2026-03-10):** Shifted to `server/src/index.ts`, which was still mixing websocket/server coordination with the full workspace-browsing subsystem. Extracted local/remote file search, active-search cancellation, git-aware directory listing, and SSH-backed remote directory reads into `WorkspaceBrowser.ts` (428 LOC). `server/src/index.ts` dropped from 1494 LOC to 1050 LOC and now focuses more tightly on state coordination, remote session handling, websocket wiring, and startup/shutdown. Verified with `cd server && npm test` and `npm run build`. Next structural seams are the remaining websocket concerns inside `server/src/index.ts`, then `ZoneRenderer.ts`, `main.ts`, and the still-large coordination logic in `TapestryView.ts`.

**Iteration 14 (2026-03-10):** Stayed on `server/src/index.ts` because the entrypoint still owned the remote-agent websocket state machine: remote session maps, activity persistence, git status tracking, working-timeout cleanup, and agent message handling. Extracted that subsystem to `RemoteAgentCoordinator.ts` (377 LOC), including remote session lifecycle, activity dedup/persistence, git status bookkeeping, working-timeout expiry, and SSH tunnel reconnects. `server/src/index.ts` dropped from 1050 LOC to 741 LOC and now coordinates state assembly plus HTTP/WebSocket startup instead of owning remote agent internals. Verified with `cd server && npm test` and `npm run build`. Next structural seams are `ZoneRenderer.ts`, `main.ts`, and the still-large coordination logic in `TapestryView.ts`.
**Iteration 15 (2026-03-10):** Shifted to `main.ts`, which was still mixing bootstrap with browser input handling, debug-runtime instrumentation, and dead view-switching code. Extracted canvas/document/window event handling into `MapInteractionController.ts` (361 LOC), moved debug runtime surface and diagnostics snapshots into `FrontendRuntimeDiagnostics.ts` (183 LOC), and pulled city lookup helpers into `cityLookup.ts` (35 LOC) while removing the unused view-overlay/plans-switching path. `main.ts` dropped from 1316 LOC to 798 LOC and now coordinates renderer/UI setup, websocket state, and lifecycle instead of owning the full interaction lattice inline. Verified with `npm run build`. Next structural seams are `ZoneRenderer.ts` and the still-large coordination logic in `TapestryView.ts`; after that, the remaining oversize production file is `HttpApi.ts` at 986 LOC.
**Iteration 16 (2026-03-10):** Shifted to `ZoneRenderer.ts`, which was still mixing scene rendering with the worker recent-files tooltip UI. Extracted tooltip DOM ownership, hover/hide timers, fetch lifecycle, positioning, and click routing into `ZoneRendererWorkerTooltip.ts` (278 LOC). `ZoneRenderer.ts` dropped from 1413 LOC to 1178 LOC and now keeps render state plus a narrow delegation surface for tooltip hover/click APIs instead of owning the tooltip subsystem inline. Verified with `npm run build`. Next structural seams inside `ZoneRenderer.ts` are the label-drag interaction controller and the city/worker render construction paths; after that, `TapestryView.ts` and `HttpApi.ts` remain the largest oversize production files.
**Iteration 17 (2026-03-10):** Stayed on `ZoneRenderer.ts` because the label interaction state machine was still embedded inside rendering: worker/city label click wiring, hover callbacks, screen-to-world drag conversion, drag listener lifecycle, and click suppression after drags. Extracted that subsystem to `ZoneRendererLabelInteractions.ts` (242 LOC). `ZoneRenderer.ts` dropped from 1178 LOC to 976 LOC and now focuses on scene construction, render diffing, animation, and tooltip coordination instead of owning DOM label interaction mechanics. Verified with `npm run build`. Next structural seams are the city/worker render construction paths inside `ZoneRenderer.ts`; after that, `TapestryView.ts` and `HttpApi.ts` remain the largest oversize production files.
**Iteration 18 (2026-03-10):** Stayed on `ZoneRenderer.ts` because entity construction and render-time hit testing were still embedded inside the renderer alongside scene coordination. Extracted city sprite fallback meshes, worker/orphan swarm assembly, label DOM creation, hex-grid overlays, activity decals, hit tests, and swarm disposal into `ZoneRendererEntities.ts` (536 LOC). `ZoneRenderer.ts` dropped from 976 LOC to 463 LOC and now coordinates ground plane/rhumb lines, state diffing, animation policy, tooltip delegation, and diagnostics instead of owning the full city/worker render subsystem. Verified with `npm run build`. Next structural targets are `HttpApi.ts` at 986 LOC and the still-large coordination logic in `TapestryView.ts`.
