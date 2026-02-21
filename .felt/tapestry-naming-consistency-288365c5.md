---
title: 'Tapestry naming consistency: rhizome → tapestry rename'
status: closed
tags:
    - '[portolan]'
created-at: 2026-02-14T17:30:03.305303+01:00
closed-at: 2026-02-15T01:40:59.945761+01:00
outcome: 'Complete. All rhizome → tapestry renames done in one pass: RhizomeView.ts → TapestryView.ts (class, types, CSS classes), HttpApi.ts endpoints /rhizome → /tapestry, test file renamed, export script renamed, both index.html files, CLAUDE.md deep-dive labels. grep -ri rhizome returns nothing outside .felt/ and node_modules/. 239 tests pass. Commit 5b61dfc.'
---

This is your spec for a Ralph loop, a meditative iteration toward a desired state.

## Desired State

The codebase uses **tapestry** consistently as the name for the fiber DAG visualization. The old name "rhizome" is fully retired — no user-facing strings, no CSS class prefixes, no endpoint paths, no file names use it. The system is clean and coherent:

- **TypeScript identifiers**: Classes, methods, variables use `tapestry`/`Tapestry` instead of `rhizome`/`Rhizome`. `RhizomeView` → `TapestryView`, `RhizomeNode` → `TapestryNode`, etc.
- **File names**: `RhizomeView.ts` → `TapestryView.ts`, `export-rhizome.ts` → `export-tapestry.ts`, test files similarly.
- **CSS classes**: `.rhizome-*` → `.tapestry-*` across `index.html` and `src/static/index.html`.
- **API endpoints**: `/rhizome` → `/tapestry`, `/rhizome-asset` → `/tapestry-asset`.
- **Test files and descriptions**: updated to match.
- **CLAUDE.md and fibers**: references updated. Debug curl examples use new endpoint names.
- **All tests pass** after each iteration (`cd server && npm test`).
- **No functional changes** — this is purely naming. Behavior, layout, data structures stay identical.

### Scope fence

- Only rename `rhizome` → `tapestry`. Don't refactor logic, add features, or restructure.
- Don't touch `.felt/` fiber bodies that mention "rhizome" as a concept (the metaphor is fine in prose). Only rename code identifiers, CSS classes, endpoints, and file names.
- The static build (`src/static/`) and export script must stay in sync with the main app.

### Done condition

`grep -ri "rhizome" --include="*.ts" --include="*.html" --include="*.json" -l` returns nothing except `.felt/` fibers and `node_modules/`. All tests pass. The app renders identically.

## Context

### Where rhizome lives

- `src/ui/RhizomeView.ts` — main class (~1700 lines, ~144 occurrences). The big one.
- `server/src/HttpApi.ts` — endpoint handler, ~18 occurrences. Routes: `/rhizome`, `/rhizome-asset`.
- `index.html` — ~110 CSS class occurrences (`.rhizome-*` selectors).
- `src/static/index.html` — static build styles, mirrors main `index.html`.
- `server/src/__tests__/HttpApi.rhizome.test.ts`, `HttpApi.claims.test.ts` — test files.
- `scripts/export-rhizome.ts` — static export script.
- `src/main.ts`, `src/ui/AnnotationPanel.ts` — light references.
- `CLAUDE.md` — debug curl examples, architecture docs.

### Approach

Each iteration should use the **code-simplifier agent** in parallel to scan for inconsistencies, stale references, and naming drift. Launch it at the start of your contribute phase:

```
Task tool → subagent_type: "code-simplifier", run_in_background: true
```

Then work on renaming while it runs. Check its findings before exiting and address what you can.

### Rename strategy

Work file-by-file, largest impact first. After renaming identifiers in a `.ts` file, update the corresponding CSS classes in both `index.html` files, then run tests. Commit after each coherent unit (e.g., "Rename RhizomeView → TapestryView" as one commit).

Git renames (`git mv`) for file renames so history tracks.

## Skills

- `/felt` — before exiting each iteration
