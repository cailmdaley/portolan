---
title: File tree browser
status: open
tags:
    - portolan
depends-on:
    - click-me
created-at: 2026-02-25T15:46:11.122172+01:00
---

(file-tree-browser)=
## Desired State

The CityHUD's two floating corner widgets (header top-right, fibers bottom-right) are unified into a single right-edge sidebar. The sidebar has three zones stacked vertically: header (city info, git, workers), tabbed content (Fibers | Files), and search bar. The Files tab shows a lazy-loaded directory tree rooted at the city's project path. Clicking a file opens it in the existing FileViewerModal. The tree works for both local and remote (SSH) cities.

```
┌─────────────────────────┐
│ City Name           [×] │
│ /path/to/project        │
│ main ↑0 ↓2  +3 ~1      │
│ Workers: ● alice ○ bob  │
├─────────────────────────┤
│ [Fibers] [Files]        │
│                         │
│  (fiber list or tree)   │
│                         │
│                         │
├─────────────────────────┤
│ 🔍 Search files & fibers│
└─────────────────────────┘
```

### Done conditions

- Two corner widgets replaced by one right-edge sidebar panel
- Header zone: city name, path, git status, workers — same content as current header widget
- Tab bar toggles between `Fibers` and `Files` views
- Fibers tab: identical behavior to current fiber list (open + recently closed, handoff buttons)
- Files tab: lazy-loaded directory tree. Directories expand/collapse on click. One level fetched per expand
- `.gitignore`-respected where possible; graceful fallback where not
- File click opens FileViewerModal (reusing existing `onOpenFile` callback)
- Works for remote cities via SSH
- Search bar at bottom: context-sensitive to active tab
- Sidebar slides in from right on city click, slides out on close
- Visual style: Porch Morning palette, same fonts, consistent with existing aesthetic
- No new dependencies

### Scope fence

- **No drag-and-drop, rename, delete, or file creation.** Browse + open only.
- **No file icons by extension.** Folder (▶/▼) vs file distinction only.
- **No file sizes, no breadcrumbs.** Minimal v1.
- **No persistent tree state across sidebar close/reopen.** Fresh each time is fine.
- **Do not modify FileViewerModal internals.** Reuse `onOpenFile` callback as-is.
- **Sidebar replaces the two widgets — don't keep both systems.**

## The Sidebar Refactor

This is the hard part. CityHUD.ts (~500 LOC) has two independent widgets with their own positioning, event handlers, and lifecycle. Merging them into one sidebar means rethinking several things:

**Layout.** The sidebar is `position: fixed`, right edge, full viewport height, ~320px wide. It overlays the map — does not push or resize the Three.js canvas. The map remains interactive behind/beside it. Width should be a CSS variable so it's easy to tune.

**Relationship to tapestry.** TapestryView also renders on the right side (detail panel, sidebar). When tapestry is open, the city sidebar is hidden (you're in tapestry mode, not map mode). These two never coexist. Check how tapestry shows/hides and make sure the city sidebar respects the same state transitions.

**Event handler migration.** The current HUD has:
- `clickOutsideHandler` on document (close on outside click)
- `escapeHandler` on document (escape collapses search first, then closes HUD)
- `ignoreNextClick` flag (prevents the city click that opened the HUD from immediately closing it)
- HMR-safe cleanup (stored listener refs, removed in `destroy()`)

All of these need to work identically in the sidebar. The click-outside boundary changes (the sidebar is one element now, not two), but the logic is the same. Don't lose `ignoreNextClick` — it's subtle and necessary.

**Show/hide animation.** Current widgets just toggle `visible` class. The sidebar should slide: `transform: translateX(100%)` → `translateX(0)` with a CSS transition (~250ms ease). The content should be ready before the slide completes — fetch fibers on show, not after animation ends.

**Scroll.** The content zone (between header and search) needs `overflow-y: auto`. Header and search bar are fixed-height anchors. The fiber list and file tree both scroll within this zone. Only the active tab's content scrolls — the inactive tab is `display: none`.

## The File Tree

**Lazy loading.** Each directory starts collapsed. On first expand, send `listDirectory` to the server, render children when response arrives. Cache the response in a `Map<string, DirectoryEntry[]>` keyed by absolute path. Subsequent expand/collapse is purely client-side (toggle children visibility). Cache is cleared on sidebar close.

**Loading state.** When a directory expand is waiting for the server, show a subtle spinner or "..." in the expanded row. For remote cities, this could take 200ms+. Don't block the UI — the rest of the tree stays interactive.

**Error handling.** SSH can fail mid-browse (connection dropped, permission denied). Show an inline error in the directory row ("couldn't read directory") — don't close the sidebar or lose existing tree state. The user can retry by collapsing and re-expanding.

**Filtering.** In git repos: use `git ls-files --others --exclude-standard` combined with tracked files to get the gitignore-filtered view. Or batch-check with `git check-ignore --stdin`. For non-git dirs (rare but possible): just `readdir` and skip obvious junk (`.git`, `node_modules`, `__pycache__`, `.DS_Store`). Don't over-engineer this — a hardcoded skip-list is fine for non-git dirs.

**Remote listing.** Same SSH exec pattern as `searchRemote` in `index.ts`. Prefer `fd --max-depth 1 --type f --type d` (respects `.gitignore` by default), fall back to `ls -1AF` + parse trailing `/` for dir detection. The `execFileAsync` + `shellEscape` pattern from the codebase avoids injection. Be aware of the parallel SSH ControlMaster exhaustion gotcha — single directory listings are fine (one SSH call per expand), but rapid clicking could queue up. Consider a simple in-flight guard: if a listing for this path is already pending, don't send another.

**Sort.** Directories first, then files. Case-insensitive alphabetical within each group. Server-side sort (so it's consistent across local and remote).

**Tree node structure.** Each entry is a `<li>` with `data-path` (absolute) and `data-type` (file/dir). Depth is encoded as `padding-left: ${depth * 16}px`. Directory rows get a toggle arrow (▶ collapsed, ▼ expanded). File rows are plain. Click on directory toggles expand/collapse. Click on file calls `onOpenFile`. Use event delegation on the tree container (one click handler), not per-row listeners.

## Search Interaction

The search bar sits at the bottom of the sidebar regardless of active tab. Its behavior is tab-sensitive:

- **Fibers tab active:** Search works exactly as it does today — sends `searchFiles` WS messages for filename and content matches, filters fiber list client-side, shows mixed results.
- **Files tab active:** Search filters the currently-expanded tree entries client-side (substring match on entry name). Only filters what's visible — doesn't expand collapsed directories to search inside them. For deep search, the user switches to Fibers tab where `rg`/`fd` do the heavy lifting.
- **Switching tabs clears the search input and collapses search results.** This is simpler than trying to translate search state between tabs.

## Context

### Files to read

- `src/ui/CityHUD.ts` — The main refactor target. Two widgets become one sidebar. All fiber list, search, worker, and git rendering logic stays; DOM structure and CSS positioning change.
- `src/ui/FileViewerModal.ts` — Opens files via `onOpenFile(fullPath, originId, cityPath, cityId, line?)`. Don't modify; wire tree click to this callback.
- `src/ui/hud-types.ts` — Types. Add `DirectoryEntry`: `{name: string, type: 'file' | 'dir'}`.
- `server/src/index.ts` — WS message handlers. `handleSearchFiles` (line 707) is the pattern for the new `listDirectory` handler. Cities resolved via `cityManager.getCityById()`. Local vs remote branching same as search.
- `src/static/index.html` — CSS. Current HUD styles under `#city-hud`. Replace corner-anchored positioning with sidebar flexbox layout.
- `src/ui/main.ts` — Wires HUD to map interactions. `cityPanel.show(city)` call site. Check what else references the HUD's position/visibility.
- `src/ui/TapestryView.ts` — Has its own sidebar/detail panel on the right. Understand how it shows/hides to avoid conflicts.

### Server-side pattern

- **WS message:** `{type: 'listDirectory', cityId, path}` → `{type: 'directoryListing', cityId, path, entries: [{name, type}]}` sorted dirs-first, then case-insensitive alpha.
- **Local:** `fs.readdir(path, {withFileTypes: true})`. Filter via `git check-ignore --stdin` in git repos, hardcoded skip-list otherwise.
- **Remote:** SSH exec `fd --max-depth 1 --type f --type d` preferred, `ls -1AF` fallback. Same `execFileAsync` + `shellEscape` pattern.

## Skills

Activate before working:
- `/implementing-code`
