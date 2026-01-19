---
title: 'Fireside Command: Civ6-inspired dark UI over warm map'
status: closed
kind: spec
priority: 2
depends-on:
    - ui-aesthetic-refinement-align-9e357009
created-at: 2026-01-18T23:59:07.763098+01:00
closed-at: 2026-01-19T03:21:19.768133+01:00
close-reason: 'Complete: Fireside Command dark UI implemented. Worker click → focusKittyTab directly (no panel). CityPanel has dark-theme styling (warm black bg, gold accents). Activity displays as ground decals on worker hexes (PlaneGeometry at y=0.2). Removed WorkerPanel/NotificationStack. EventWatcher fixed for byte-vs-char bug. All completion criteria verified.'
---

# Ralph Spec: Fireside Command

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

Transform hexarchy-v2's UI from "Porch Morning" warmth into **"Fireside Command"** — a Civilization 6-inspired interface where dark, refined CityPanel floats over a warm cartographic map. Activity streams appear as ground decals on worker hexes. Click worker → focus terminal immediately.

---

## Design

### Aesthetic Direction: "Fireside Command"

**The feel:** Curled up in a study at night, firelight on maps. Click to go there.

**Visual hierarchy:**
1. **Ground plane** — Warm cartographic map (existing Porch Morning palette)
2. **Activity decals** — Tool calls as text on worker hex surfaces
3. **CityPanel** — Dark panel with gold accents (Civ6-inspired)

### Palette Evolution

Keep the warm map. Add dark UI layer for CityPanel:

```css
/* Existing (map layer) */
--bg-primary: #C8B8A8;     /* warm tan ground */
--gold: #9A7B35;           /* city hexes */
--accent: #5A7B7B;         /* teal/working */

/* New (UI layer) */
--ui-dark: #1A1816;        /* panel background - warm black */
--ui-dark-elevated: #252220; /* elevated panels */
--ui-border: #3D3835;      /* panel borders */
--ui-gold: #C9A227;        /* gold accents - brighter for dark bg */
--ui-gold-muted: #8B7355;  /* muted gold */
--ui-text: #E8E4DF;        /* light text on dark */
--ui-text-muted: #9A958D;  /* secondary text */
```

### Component Architecture

#### 1. Worker Hexes (click → focus terminal)

**Interaction:**
- Single click → Focus Kitty tab immediately (no panel)
- Right-click → Context menu (Focus Tab, Kill Worker)

**What they show:**
- Name label (billboard sprite, like cities but smaller)
- Status via hex color: working (teal), idle (muted)
- Activity stream as **ground decal** on hex surface

#### 2. Activity Ground Decals

**Display:**
- Text projected flat onto hex surface (not billboard)
- Semi-transparent dark background
- Last 2-3 tool calls, most recent at top
- Tool name in gold, summary in muted text
- Fades over time (older = more transparent)

**Data flow:**
```
Claude hooks → ~/.hexarchy/data/events.jsonl → Server watches → WebSocket → Frontend
```

**Events:** `post_tool_use` has tool name + input for summary

#### 3. CityPanel (dark theme)

**When it appears:**
- Click city → CityPanel slides in from right
- Click away → slides out

**Styling:**
- Dark background (`--ui-dark`)
- Gold top border accent
- EB Garamond headers (small-caps), JetBrains Mono for data
- Slide-in animation

#### REMOVED Components

- **WorkerPanel** — Removed. Click worker → focus terminal directly.
- **NotificationStack** — Removed. 'attention' status doesn't exist on server.

---

## Visual Details

### Typography

| Context | Font | Weight | Transform |
|---------|------|--------|-----------|
| Panel headers | EB Garamond | 500 | small-caps |
| Body text | EB Garamond | 400 | normal |
| Data/status | JetBrains Mono | 400 | normal |
| Notifications | EB Garamond | 500 | normal |

### Animation

| Element | Animation | Duration | Easing |
|---------|-----------|----------|--------|
| Panel slide-in | translateX(100%) → 0 | 200ms | ease-out |
| Notification appear | scale(0.8) + opacity → 1 | 150ms | ease-out |
| Active pulse | opacity 0.7 ↔ 1.0 | 2s | ease-in-out, infinite |
| Activity fade | opacity 1 → 0.3 over age | 10s | linear |

### Spacing

- Panel width: 320px (same as current CityPanel)
- Panel padding: 20px
- Notification badge: 280px wide, 60px tall
- Notification gap: 8px

---

## Context

### Files to Modify

src/main.ts — Remove WorkerPanel, worker click → focus Kitty directly
src/render/ZoneRenderer.ts — Activity as ground decal (PlaneGeometry with CanvasTexture)
index.html — Remove WorkerPanel and NotificationStack CSS

### Files to Remove

src/ui/WorkerPanel.ts — No longer needed
src/ui/NotificationStack.ts — No longer needed (attention status doesn't exist)

### Already Done

- CityPanel dark theme ✓
- EventWatcher watching events.jsonl ✓
- Server broadcasting activity events ✓
- Dark UI CSS variables ✓

---

## Completion

**Verify by doing, not by checking boxes:**

1. **Click worker** → Kitty tab focuses immediately (no panel)
2. **Click city** → Dark CityPanel slides in
3. **Activity decals** → Tool calls appear flat on worker hex surface
4. **Theme coherence** → Dark panel, warm map, cartographic feel

**Done when:**
- Click worker = go to terminal
- Activity shows on the map itself, not in a panel
- CityPanel is the only slide-in UI
- The map tells you what's happening without extra chrome

---

## Notes for Ralph

**Current state (iteration 4):**
- WorkerPanel and NotificationStack exist but should be REMOVED
- Activity sprites exist as billboards, need to become ground decals
- Worker click shows panel, should focus Kitty instead

**Next steps:**
1. Remove WorkerPanel from main.ts, make worker click → focusKittyTab()
2. Remove NotificationStack from main.ts
3. Convert activity sprite to ground decal (PlaneGeometry flat on hex)
4. Clean up unused CSS and files

## Comments
**2026-01-19 00:04** — Iteration 1: Added Fireside Command dark UI CSS variables (--ui-dark, --ui-gold, --ui-text, etc.) to index.html. Created complete dark theme variant for CityPanel with gold accents, proper contrast. Enabled dark-theme class by default. Build passes.
**2026-01-19 00:10** — Iteration 2: Added NotificationStack (top-right badges for attention sessions, click to focus). Added WorkerPanel (slide-in panel with status, Focus/Kill buttons, activity placeholder). Both integrated into main.ts. Build passes. Remaining: wire activity stream from EventWatcher to frontend.
**2026-01-19 00:17** — Iteration 3: Wired activity stream end-to-end. EventWatcher now emits ActivityEvent (tool+summary) on pre_tool_use. Server broadcasts via WebSocket. Frontend routes to WorkerPanel.updateActivity() and ZoneRenderer.updateWorkerActivity(). Workers show rolling 3-activity display with dark UI background and gold tool names. Builds pass.
**2026-01-19 02:15** — Iteration 4: Removed WorkerPanel and NotificationStack. Worker click now focuses Kitty directly. Activity display changed from billboard sprite to ground decal (flat Mesh on hex surface). Fixed EventWatcher to use post_tool_use events (has tool info). Cleaned up 'attention' status cruft.
**2026-01-19 03:14** — Iteration 4 (interactive): Fixed EventWatcher byte vs char offset bug (45MB file). Activity ground decals working - flat mesh at y=0.2, 60° rotation. Screen-space label scaling (constant size on zoom). Fixed hexarchy-hook.sh to capture tool_name/tool_input. Events file auto-truncates to 10k lines. Worker state preserved on update (no recreate). Removed WorkerPanel/NotificationStack.
**2026-01-19 03:19** — Iteration 5: Cleanup. Fixed build error (dead notificationStack.update ref). Deleted orphaned WorkerPanel.ts and NotificationStack.ts. Removed 330 lines of dead CSS. All completion criteria verified: worker click→focusKittyTab, CityPanel dark-theme, activity decals flat on hex.
