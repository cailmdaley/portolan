---
title: 'Worker activity panel: activity history + file viewer modal'
status: closed
kind: spec
priority: 2
created-at: 2026-01-20T21:00:15.248793+01:00
closed-at: 2026-01-20T21:21:58.168963+01:00
close-reason: Implemented worker activity panel and file viewer modal. Panel shows last 10 activities per session with relative timestamps, color-coded tool badges (Read/Write/Edit/Bash/Glob/Grep/Task), and clickable file entries. File viewer modal uses Prism.js for syntax highlighting with line numbers, markdown toggle (rendered/source), and copy button. Supports both local and remote files via SSH. All CSS follows Porch Morning aesthetic. 99 tests pass.
---

# Ralph Spec — Worker Activity Panel

You are in a Ralph loop — autonomous iteration toward completion.

---

## Your Rhythm

1. **Survey** — Read previous work for orientation (`felt downstream <fiber-id>`).
   Use it for context — files touched, concepts named — but apply fresh judgment.
   Scan the spec and codebase. What's incomplete? What needs verification? What could improve?

2. **Prioritize** — Identify the single highest-value task to work on yourself.
   This is what you'll focus on in this session.

3. **Delegate** — Any routine, isolated tasks can be launched as background agents (2-3 max, different files).
   For each: create child fiber, launch with Task tool (run_in_background: true).
   Do NOT check their progress or output. They will notify you when finished.

4. **Work** — Focus on your high-value task. If agents finish while you're working, briefly note their results and continue.
   If you have nothing to work on yourself, just wait for agents to complete.

5. **Exit** — End every iteration with `kill $PPID`. The loop continues.

   **NEVER close the fiber if you made changes this iteration.**
   Made an edit? Fixed a bug? Added a test? → `kill $PPID`. That's it. Don't close.

   **Only close when you've actively checked everything and found nothing:**
   - You surveyed the full design and verified each part is implemented
   - You ran tests and they pass
   - You tried interacting with what was built and it works
   - You looked for edge cases, documentation gaps, code smells — nothing found
   - You made zero changes this iteration

   If ALL of that is true → `felt off <fiber-id> -r "summary"` then `kill $PPID`.
   If ANY of it is false → just `kill $PPID`. The loop continues.

---

## Key Principles

- **Form your own understanding of completion.** Don't mechanically check boxes. Read the design, understand the intent, verify that the implementation matches.
- **Fresh eyes each iteration.** Previous work informs but doesn't bind. Apply fresh judgment.
- **Light parallelism.** Chunk when it helps, but don't force it. Sequential is fine.
- **Don't poll agents.** They notify you. Compulsive checking burns context.

---

## Goal

Add a Worker Activity Panel that shows activity history with clickable file entries that open a centered modal file viewer with syntax highlighting and markdown rendering.

## Design

### Overview

When you click a worker hex, a panel slides in showing that worker's recent activity history (last 10 events). Each activity shows the tool used, file/command involved, and timestamp. Clicking a file activity opens a centered modal with the file contents.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       SERVER CHANGES                        │
│                                                             │
│  ActivityHistory (new)                                      │
│  └── Stores activity history per session (last 10 events)   │
│  └── Indexed by tmuxSession                                 │
│                                                             │
│  Enhanced ActivityEvent                                     │
│  └── fullPath (not just filename)                           │
│  └── cwd (working directory)                                │
│  └── toolInput (for bash commands, patterns, etc.)          │
│                                                             │
│  HttpApi additions                                          │
│  └── GET /activity/:sessionId — fetch history               │
│  └── GET /file-content — fetch file for viewing             │
│      (accepts path + optional originId for remote files)    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      BROWSER CHANGES                        │
│                                                             │
│  WorkerActivityPanel (new: src/ui/WorkerActivityPanel.ts)   │
│  └── Left-side panel (mirrors CityPanel on right)           │
│  └── Adjustable width (like CityPanel)                      │
│  └── Shows selected worker's activity feed                  │
│  └── Clickable file entries → open modal                    │
│                                                             │
│  FileViewerModal (new: src/ui/FileViewerModal.ts)           │
│  └── Centered popup modal for file contents                 │
│  └── Syntax highlighting via Prism.js                       │
│  └── Markdown rendering via marked (already used)           │
│  └── Line numbers, copy button                              │
│  └── Full path breadcrumb, language badge                   │
│                                                             │
│  main.ts changes                                            │
│  └── Click worker → open WorkerActivityPanel                │
│  └── Store activity history (last 10 per session)           │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

**Activity capture (enhanced):**
```typescript
// Current: only filename
{ tool: "Read", summary: "main.ts", timestamp: 1234567890 }

// Enhanced: full context
{
  tool: "Read",
  summary: "main.ts",           // For quick display
  fullPath: "/Users/x/project/src/main.ts",
  cwd: "/Users/x/project",
  timestamp: 1234567890,
  toolInput: { file_path: "...", limit: 100 }  // Full tool params
}
```

**File content fetching:**
```
Browser                          Server
───────                          ──────
Click "Read main.ts" activity
    ↓
GET /file-content?path=/Users/x/project/src/main.ts
    ↓                              ↓
                            fs.readFile(path)
                                   ↓
    ←─────────────────────────  { content, language }
    ↓
Render with syntax highlighting
```

**Remote files:**
```
GET /file-content?path=/home/user/project/src/main.ts&originId=candide-abc123
    ↓
Server checks if originId matches connected agent
    ↓
Sends request to agent via WebSocket
    ↓
Agent reads file, responds
    ↓
Server returns content to browser
```

### UI Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│                              VIEWPORT                                 │
│                                                                       │
│  ┌─────────────────┐                              ┌─────────────────┐ │
│  │ WORKER PANEL    │                              │ CITY PANEL      │ │
│  │ (adjustable)    │                              │ (adjustable)    │ │
│  │                 │                              │                 │ │
│  │ ▼ worker-name   │      HEX MAP                 │ Fibers...       │ │
│  │   Session: abc  │                              │                 │ │
│  │   Origin: local │                              │                 │ │
│  │                 │                              │                 │ │
│  │ ─────────────── │                              │                 │ │
│  │ Activity Feed   │                              │                 │ │
│  │                 │                              │                 │ │
│  │ 2m ago Read     │                              │                 │ │
│  │   main.ts  ←click opens modal                  │                 │ │
│  │                 │                              │                 │ │
│  │ 3m ago Write    │                              │                 │ │
│  │   utils.ts                                     │                 │ │
│  │                 │                              │                 │ │
│  │ 5m ago Bash     │                              │                 │ │
│  │   npm test      │                              │                 │ │
│  │                 │                              │                 │ │
│  └─────────────────┘                              └─────────────────┘ │
│                                                                       │
│            ┌────────────────────────────────────┐                     │
│            │      FILE VIEWER MODAL             │                     │
│            │  ┌──────────────────────────────┐  │                     │
│            │  │ src/utils.ts           [copy]│  │                     │
│            │  ├──────────────────────────────┤  │                     │
│            │  │  1  export const foo = ...   │  │                     │
│            │  │  2  export const bar = ...   │  │                     │
│            │  │  3  ...                      │  │                     │
│            │  └──────────────────────────────┘  │                     │
│            └────────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────────────┘
```

Both panels have adjustable width via drag handle (same pattern as CityPanel).

### Activity Entry Rendering

Each activity entry shows:
- **Timestamp** (relative: "2m ago", "1h ago")
- **Tool icon/badge** (color-coded: Read=blue, Write=green, Edit=yellow, Bash=gray)
- **Summary** (filename, command, pattern) — clickable for file activities

Tool-specific display:
- **Read/Write/Edit**: Show filename, click opens modal with file contents
- **Bash**: Show command (full, not truncated)
- **Glob/Grep**: Show pattern (not clickable)
- **Task**: Show description (not clickable)

### File Viewer Modal

Centered modal (not constrained by panel width) showing:
- **Full path breadcrumb** at top
- **Language badge** (ts, js, md, json, etc.)
- **Line numbers**
- **Syntax highlighting** (Prism.js — already common, lightweight)
- **Copy button** (top right)
- **Close button** (X or click outside)
- **Max height with scroll** (80vh or similar)

For markdown files:
- Toggle between rendered and source view
- Use existing `marked` library

### Styling (Porch Morning aesthetic)

```css
.worker-panel {
  /* Mirror CityPanel positioning but on left */
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 380px;
  min-width: 280px;
  max-width: 600px;
  background: var(--bg-card);
  border-right: 1px solid var(--text-muted);
  /* Adjustable width via drag handle */
}

.activity-entry {
  border-bottom: 1px solid rgba(0,0,0,0.1);
  padding: 12px 16px;
  cursor: pointer; /* clickable */
}

.activity-tool-badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  padding: 2px 6px;
  border-radius: 3px;
}

.activity-tool-badge.read { background: #E3F2FD; color: #1565C0; }
.activity-tool-badge.write { background: #E8F5E9; color: #2E7D32; }
.activity-tool-badge.edit { background: #FFF8E1; color: #F57F17; }
.activity-tool-badge.bash { background: #ECEFF1; color: #455A64; }

/* Centered modal */
.file-viewer-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 80vw;
  max-width: 900px;
  max-height: 80vh;
  background: var(--bg-elevated);
  border: 1px solid var(--text-muted);
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.2);
  overflow: hidden;
  z-index: 1000;
}

.file-viewer-modal pre {
  margin: 0;
  padding: 16px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem;
  overflow: auto;
  max-height: calc(80vh - 60px);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 999;
}
```

### Implementation Phases

**Phase 1: Server — Enhanced Activity Events & Endpoints**
- Enhance ActivityEvent to include fullPath, cwd, toolInput
- Update extractSummary to return full data (not just filename)
- Add GET /file-content endpoint (local files only first)

**Phase 2: Browser — Panel & Activity List**
- Create WorkerActivityPanel.ts following CityPanel patterns
- Adjustable width with drag handle
- Click worker hex → open panel
- Display activity history with relative timestamps, tool badges
- Clickable file entries (no expansion yet)

**Phase 3: Browser — File Viewer Modal**
- Create FileViewerModal.ts
- Add Prism.js for syntax highlighting
- Centered modal with backdrop
- Fetch file content from server on click
- Handle markdown with toggle
- Copy button, line numbers, close on Escape/click outside

**Phase 4: Remote File Support**
- Server requests file from agent via WebSocket
- Agent responds with file content
- Handle errors (file not found, agent disconnected)

## Context

Follow existing patterns in these files:

server/src/index.ts — State management, WebSocket handling, buildState pattern
server/src/activityUtils.ts — extractSummary() is the source of truth for activity parsing
server/src/HttpApi.ts — Existing REST endpoints pattern
server/src/EventWatcher.ts — How activities flow from hook → server

src/ui/CityPanel.ts — Panel structure, styling, expand/collapse pattern
src/main.ts — Click handling, panel management
index.html — CSS variables, existing styles

Use existing libraries:
- marked (already used) — markdown rendering
- Add Prism.js (CDN) — syntax highlighting

## Completion

**The spec is done when:**

1. Clicking a worker hex opens a left-side panel showing that worker's activity history (last 10)
2. Worker panel has adjustable width (drag handle, like CityPanel)
3. Activities show: relative timestamp, tool badge, summary (filename/command/pattern)
4. Clicking file activities (Read/Write/Edit) opens centered modal with file contents
5. File viewer modal has syntax highlighting (Prism.js) and line numbers
6. Markdown files render properly with toggle to source view
7. Modal closes on Escape, click outside, or X button
8. Panel closes when clicking elsewhere or pressing Escape
9. Works for both local and remote workers
10. Follows Porch Morning aesthetic (matches existing UI)
11. Tests pass, no console errors
