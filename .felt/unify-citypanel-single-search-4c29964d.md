---
title: 'Unify CityPanel: single search bar + Files/Fibers tabs'
status: closed
kind: spec
tags:
    - '[arena]'
priority: 2
created-at: 2026-01-24T13:02:29.122955+01:00
closed-at: 2026-01-24T13:55:51.297669+01:00
close-reason: 'Feature implemented: unified search + Files/Fibers tabs in CityPanel. Created RecentFilesManager (mtime polling), wired recentFiles into state, refactored CityPanel.ts (single search, tab bar, Files tab with Annotated/Recently Edited, Fibers tab with Open/Closed, fiber click opens .felt/<id>.md), added CSS for all new elements. Iterations should choose highest-value aspect to test/verify.'
---

## Goal

Consolidate CityPanel's fragmented UI (4 sections, 2 search bars) into unified search + two tabs.

## Current State

```
┌─────────────────────────────────┐
│ Files                           │  ← section header
│ [Search files...] [Name ▼] ×    │  ← separate search + mode dropdown
│ (file results)                  │
├─────────────────────────────────┤
│ Recent Annotations              │  ← section header
│ (annotation list)               │
├─────────────────────────────────┤
│ [Filter fibers...] ×            │  ← separate filter input
├─────────────────────────────────┤
│ Open Fibers                     │  ← section header
│ (fiber list)                    │
├─────────────────────────────────┤
│ Recently Closed                 │  ← section header
│ (fiber list)                    │
└─────────────────────────────────┘
```

**Problems:**
- Two search bars (file search, fiber filter)
- Mode dropdown clutter (Name/Content)
- Fragmented mental model
- Clicking fiber expands in-place (inconsistent with files)

## Target State

```
┌─────────────────────────────────┐
│ [Search files & fibers...] ×   │  ← unified search
├─────────────────────────────────┤
│ [Files]  [Fibers]              │  ← tab bar (Files default)
├─────────────────────────────────┤
│ (tab content OR search results) │
└─────────────────────────────────┘
```

**Unified Search:**
- Single input, searches files (name + content) and fibers (title + body + reason)
- Combined results with type indicators (📄 file, ○/◐/● fiber status)
- Results replace tab content while searching; clear restores tabs
- No mode dropdown — search both name and content automatically

**Files Tab (default):**
- "Recent Annotations" → 3 most recently annotated files
- "Recently Edited" → 10 most recently modified files (mtime)
- Click any file → FileViewer

**Fibers Tab:**
- "Open" → open fibers, rich display (status icon, kind badge, handoff button)
- "Recently Closed" → closed fibers, same display
- Click fiber → FileViewer on `.felt/<id>.md`

## Decisions (locked)

| Choice | Decision |
|--------|----------|
| Recent files | Include — RecentFilesManager follows GitStatusManager pattern |
| Fiber click | FileViewer on .felt/<id>.md — consistent with files |
| Search results | Merged + typed (📄/○/◐/●) — unified feel |

## Implementation

### 1. RecentFilesManager (server/src/RecentFilesManager.ts)

New manager, follows GitStatusManager pattern:
- `track(path)` / `untrack(path)` for city paths
- Polls every 10s (less frequent than git — mtime changes less often)
- For each tracked path: `find . -type f -not -path '*/\.*' -not -path '*/node_modules/*' ... -exec stat`
- Cache top 20 most recent files per path
- Returns `{ path, fullPath, mtime }[]`
- For remote: SSH exec same find command

**Exclude:** `.git/`, `node_modules/`, `dist/`, `build/`, `.felt/`, `__pycache__/`, `*.pyc`

### 2. MessageRouter addition

New message: `getRecentFiles`
```typescript
case 'getRecentFiles':
  const files = recentFilesManager.getForPath(msg.cityPath);
  ws.send(JSON.stringify({ type: 'recentFiles', cityId: msg.cityId, files }));
```

Or: include in state broadcast (simpler — recentFiles per city in buildState)

### 3. CityPanel.ts refactor

**Remove:**
- `fileSearchInput`, `fileSearchClear`, `fileSearchMode` (mode dropdown)
- Separate fiber filter (`searchInput`, `searchClear`)
- `recentAnnotationsList` as separate section

**Add:**
- Single `unifiedSearchInput` at top
- Tab bar component: `tabBar`, `activeTab: 'files' | 'fibers'`
- `tabContent` container

**State:**
- `recentFiles: RecentFile[]` — fetched on show
- `activeTab: 'files' | 'fibers'`
- `searchQuery: string`
- `searchResults: (SearchResult | Fiber)[]` — merged results

**Behavior:**
- Empty search → show active tab content
- Typing → debounce 150ms → search files (name+content) AND filter fibers
- Merge results: files first (📄), then fibers (○/◐/●)
- Click file → `onOpenFile(fullPath, originId)`
- Click fiber → `onOpenFile(feltPath + '/' + id + '.md', originId)`

### 4. FileViewerModal.ts

Already handles .md files. May want to detect .felt/ paths and show fiber metadata in header (optional polish).

## Key Files

| File | Change |
|------|--------|
| `server/src/RecentFilesManager.ts` | **New** — mtime polling |
| `server/src/index.ts` | Wire manager, add to buildState |
| `server/src/MessageRouter.ts` | Add `getRecentFiles` if not in state |
| `src/ui/CityPanel.ts` | **Major refactor** — unified search, tabs |
| `src/ui/FileViewerModal.ts` | Optional: fiber metadata display |

## Verification

1. Open CityPanel → see unified search + two tabs
2. Files tab shows "Recent Annotations" (3) and "Recently Edited" (10)
3. Fibers tab shows Open and Recently Closed with rich display
4. Type in search → combined results with type indicators
5. Click file → FileViewer opens
6. Click fiber → FileViewer opens `.felt/<id>.md`
7. Clear search → back to tab view
8. Works for remote cities (SSH-based mtime + file search)
9. Handoff button still works on fibers
