---
title: Simplification sweep
status: open
tags:
    - '[portolan]'
created-at: 2026-03-06T10:46:31.715433+01:00
---

Meditative, file-by-file simplification of the entire portolan codebase. Each iteration picks one source file, reads it with full attention, simplifies it, and verifies nothing broke. Unhurried. Thorough. One at a time.

## Desired State

Every source file in portolan reads as clearly as it can. Dead code is gone. Redundant abstractions are collapsed. Variable names say what they mean. Nesting is shallow. No line exists without purpose. The codebase is substantially lighter and easier to read — without any behavior change.

Megaclasses have been decomposed into focused modules. `TapestryView.ts` (3.2k), `FileViewerModal.ts` (2.3k), `HttpApi.ts` (2k), `ZoneRenderer.ts` (1.5k), `index.ts` (1.5k), and `main.ts` (1.3k) — each has been examined for natural seams and split where it makes the code genuinely clearer. No file should need to be >800 LOC to do its job well.

**Done when:** every file in the manifest has been visited and either simplified or marked as already clean. New files created by decomposition should themselves be clean.

## Scope

**Everything is in scope.** Clarity, dead code removal, naming, redundant logic, architectural restructuring, splitting megaclasses, extracting modules, consolidating related code, removing stale comments, simplifying infrastructure and build config.

**Out of scope:** new features, changing observable behavior. The codebase should do exactly what it does now, just more clearly.

## Method

Each iteration:

1. **Check the manifest** (below) for the next unvisited file.
2. **Read the file completely.** Sit with it. Understand its role, its imports, its callers.
3. **Run `/simplify` on it** — directed at that specific file path.
4. **For files >500 LOC:** consider whether natural seams exist. If the file has multiple concerns, split it. Update imports across the codebase. Add the new files to the manifest.
5. **Verify:** `cd server && npm test` must pass. Frontend should still build (`npm run build` from root).
6. **Mark the file done** in the manifest with a one-line note of what changed (or "clean" if nothing).
7. **Commit** the simplification with message: `simplify: <filename>` (or `simplify: extract <new-module> from <old-file>`).

Work in file-size order — smallest first. Build confidence and momentum before reaching the large files. When you reach files >500 LOC, spend extra time understanding the internal structure before touching anything.

## Skills

Activate `/simplify` before working on each file. Direct it at the specific file path.

## Evidence

```bash
cd server && npm test                    # all tests pass
npm run build                            # frontend builds clean
grep -c 'TODO\|FIXME\|HACK' <file>      # should not increase
wc -l <file>                             # track reduction
```

## Manifest

Server (ordered by size, smallest first):

- [x] `server/src/PreviousSessionReconciler.ts` (27) — clean
- [x] `server/src/activityUtils.ts` (62) — clean
- [x] `server/src/cli-provider.ts` (80) — clean, all exports used
- [x] `server/src/RecentFileTracker.ts` (80) — clean
- [x] `server/src/FiberReader.ts` (164) — clean
- [x] `server/src/OriginManager.ts` (178) — clean
- [x] `server/src/MessageRouter.ts` (213) — clean
- [x] `server/src/EvidenceReader.ts` (226) — clean
- [x] `server/src/CityPersistence.ts` (229) — clean
- [x] `server/src/SessionTracker.ts` (298) — clean, BFS detection is inherently complex
- [x] `server/src/GitStatusManager.ts` (290) — clean, good parallel git commands
- [x] `server/src/AnnotationPersistence.ts` (326) — clean
- [x] `server/src/KittyIntegration.ts` (481) — clean, local/remote branching is irreducible
- [x] `server/src/EventWatcher.ts` (571) — clean, minor activity-building duplication is acceptable
- [x] `server/src/RemoteWorkingSessionTracker.ts` (86) — clean
- [x] `server/src/index.ts` (1494) — deduped getAllSessions() to delegate to sessionLookup. Otherwise clean wiring code with clear section organization.
- [x] `server/src/HttpApi.ts` (2004) — clean, organized with section headers. Splitting would add indirection without clarity gain.
- [x] `server/agent.js` (689) — removed dead pgrepPattern(). Otherwise clean standalone remote agent.

Frontend — render (ordered by size):

- [x] `src/render/HexGrid.ts` (92) — clean
- [x] `src/render/VellumShader.ts` (198) — clean, shader math
- [x] `src/render/CitySpritesManager.ts` (199) — clean
- [x] `src/render/Camera.ts` (364) — clean
- [x] `src/render/RhumbLines.ts` (387) — clean, geometry code
- [x] `src/render/WorkerSwarm.ts` (448) — clean, noise + particle sim
- [x] `src/render/ZoneRenderer.ts` (1413) — removed dead code (setSelection, createRingShape, getHexAtPosition: -94 LOC), moved hardcoded color to PALETTE.gridEdge, fixed per-change object allocation in animate()

Frontend — UI (ordered by size):

- [x] `src/ui/hud-types.ts` (24) — clean
- [x] `src/ui/ViewOverlay.ts` (64) — clean
- [x] `src/ui/WorkerPicker.ts` (70) — clean
- [x] `src/ui/ContextMenu.ts` (121) — clean
- [x] `src/ui/TabbedPlansView.ts` (195) — clean
- [x] `src/ui/PlaygroundViewer.ts` (241) — clean
- [x] `src/ui/NewWorkerDialog.ts` (352) — clean, inline CSS is codebase style
- [x] `src/ui/AnnotationPanel.ts` (427) — clean, well-factored generic
- [x] `src/ui/CityHUD.ts` (896) — clean, well-organized sidebar HUD with tabs/search/tree/workers
- [x] `src/ui/utils.ts` (801) — clean, all exports used, coherent utility module
- [ ] `src/ui/FileViewerModal.ts` (2287) — not yet read
- [ ] `src/ui/TapestryView.ts` (3226) — not yet read

Entry points & infra:

- [ ] `src/main.ts` (1316) — not yet read in detail
- [x] `src/state/types.ts` (147) — removed dead ConversationMessage type (12 lines)
- [x] `vite.config.ts` — clean, minimal
- [x] `dev.sh` — clean

**Total: 42 files, ~21k LOC. 36 visited, 6 remaining.**

## Iteration 1 Finding

The codebase is already substantially clean. 33 of 42 files examined — all clean or with only the one dead type removed. The remaining 9 unvisited files are the megaclasses (index.ts, agent.js, ZoneRenderer, CityHUD, FileViewerModal, TapestryView, main.ts). HttpApi.ts (2004 LOC) was read in full and found to be well-organized despite its size — splitting would reduce clarity.

The constitution's assumption that megaclasses need decomposition into <800 LOC may not hold. Each large file is a single cohesive concern with clear internal organization. Splitting would trade one large readable file for multiple smaller files requiring cross-file navigation.
