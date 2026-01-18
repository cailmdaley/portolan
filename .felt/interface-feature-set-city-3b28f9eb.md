---
title: 'Interface feature set: city panel, labels, visual polish'
status: closed
kind: spec
priority: 2
created-at: 2026-01-18T03:58:06.558273+01:00
closed-at: 2026-01-18T12:26:12.717081+01:00
close-reason: Complete. CityPanel implemented with DOM overlay, WebSocket fiber fetching, markdown+KaTeX rendering, expand/collapse, dismiss on ×/escape/outside click. City labels vermillion 48px, worker labels 32px status-colored. 80 tests pass, build succeeds.
---

# Ralph Spec

You are in a Ralph loop — autonomous iteration toward completion.

---

## Your Rhythm

1. **Survey** — Read previous work for orientation (`felt downstream interface-feature-set-city-3b28f9eb`).
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

   If ALL of that is true → `felt off interface-feature-set-city-3b28f9eb -r "summary"` then `kill $PPID`.
   If ANY of it is false → just `kill $PPID`. The loop continues.

---

## Key Principles

- **Form your own understanding of completion.** Don't mechanically check boxes. Read the design, understand the intent, verify that the implementation matches.
- **Fresh eyes each iteration.** Previous work informs but doesn't bind. Apply fresh judgment.
- **Light parallelism.** Chunk when it helps, but don't force it. Sequential is fine.
- **Don't poll agents.** They notify you. Compulsive checking burns context.

---

## Goal

Add city panel, vermillion city labels, and worker session labels to make hexarchy a navigable map.

## Design

### 1. City Panel (Side Panel)

**Architecture:** DOM overlay, not Three.js. New file `src/ui/CityPanel.ts`.

**Structure:**
```html
<div id="city-panel" class="panel">
  <button class="close-btn">×</button>
  <h2 class="city-name">hexarchy-v2</h2>
  <p class="city-path">/Users/.../hexarchy-v2</p>
  <section class="fibers">
    <h3>Open Fibers</h3>
    <ul class="fiber-list">
      <!-- fiber items -->
    </ul>
  </section>
  <section class="fibers">
    <h3>Recently Closed</h3>
    <ul class="fiber-list">
      <!-- last 3-5 closed -->
    </ul>
  </section>
</div>
```

**Trigger:** City click in `main.ts` → camera focuses AND calls `cityPanel.show(city)`.

**Data flow:**
- Frontend sends `{ type: 'getFibers', cityId }` over WebSocket
- Server responds with `{ type: 'fibers', cityId, fibers: [...] }`
- Extend `FiberReader.ts` to return full fiber objects, not just count

**Fiber display:**
- Sort: active (◐) first, then open (○) by priority
- Click to expand inline (show body/reason/comments)
- View only — no mutations

**Dismiss:** Click outside, × button, Escape key, or click different city.

**Animation:** CSS transform slide from right, 300ms ease-out.

### 2. City Labels

**Current:** Umber (#6B5344), 24px font in `ZoneRenderer.createLabel()`.

**Change:**
- Color: Vermillion (#C54B3D) — `ctx.fillStyle = PALETTE_CSS.vermillion`
- Font size: 32px (up from 24px)
- Canvas size: 512×128 (up from 256×64) for crisp rendering

**Files:** `ZoneRenderer.ts` lines 170-186 (createLabel method).

### 3. Worker Labels

**Current:** Worker hexes have no labels, just colored hex mesh.

**Add:**
- Session name label above worker hex (same technique as city labels)
- Color matches status: verdigris (working), vermillion (attention), sepia (idle)
- Font size: 18px, smaller than city labels
- Position: slightly above hex mesh

**Files:**
- `ZoneRenderer.ts` renderWorker() method (lines 243-269)
- Need session name in Session type — check if already available via ServerSession.name

**Data check:** `ServerSession.name` exists (line 25 types.ts), but normalized `Session` type drops it. Extend:
```typescript
export interface Session {
  id: string
  name: string  // ADD
  cityId: string | null
  hex: HexCoord | null
  status: 'idle' | 'working' | 'attention'
}
```

---

## Context

@src/render/ZoneRenderer.ts — hex rendering, labels
@src/main.ts — click handling, state
@src/state/types.ts — types, palette
@server/src/FiberReader.ts — fiber reading (needs expansion)
@server/src/index.ts — WebSocket server
@index.html — add panel DOM

---

## Completion

**Verify by doing:**
1. Start server and frontend (`npm run dev` in both)
2. Click a city hex → camera focuses AND panel slides in from right
3. Panel shows: city name, path, open fibers sorted by priority, last 3-5 closed
4. Click a fiber → expands inline to show body
5. Click × or outside → panel dismisses
6. City labels are vermillion, visibly larger than before
7. Worker hexes show session name, colored by status
8. Run `cd server && npm test` — all tests pass
9. No console errors in browser

**Done when:** All above work. The map is navigable — click city, see fibers, understand what's happening.

---

## Visual Language

Cartographic Warmth maintained. Cities are landmarks — vermillion makes them navigation anchors. Workers are activity — color-coded by state.

---

## Future (not this iteration)

- Research dashboard under city view
- Inline/spatial expansion (map IS interface)
- Tabbed city panel (Fibers / Workers / Research)
