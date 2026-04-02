---
title: 'City persistence: survive beyond sessions, add/delete from frontend'
status: closed
created-at: 2026-01-18T18:16:08.409108+01:00
closed-at: 2026-01-18T18:24:20.187158+01:00
---

(city-persistence-survive-beyond)=
# Ralph Spec: City Persistence

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

Add city persistence to hexarchy-v2: cities survive beyond sessions, can be added/deleted from the frontend.

## Design

### Storage Layer

**File:** `~/.hexarchy/cities.json`

```typescript
interface PersistedCity {
  id: string           // UUID, stable across sessions
  path: string         // Absolute filesystem path
  name: string         // Display name (defaults to basename)
  position: HexCoord   // { q, r } — persisted position is authoritative
  originId: string     // 'local' or 'remote-{hostname}'
  pinnedAt: number     // Timestamp when persisted
}
```

**Server component:** `CityPersistence.ts`
- `load()` — read from file on startup
- `save()` — write atomically (write to .tmp, rename)
- `pin(city)` — add to persistence
- `unpin(cityId)` — remove from persistence
- Auto-create `~/.hexarchy/` directory if missing

### CityManager Changes

**Current:** `citiesByKey: Map<key, City>` derived purely from sessions.

**New behavior:**
1. On startup, load persisted cities first
2. Session-derived cities check persisted cities for existing position
3. When session leaves a persisted city → city stays (it's persisted)
4. When session arrives at persisted path → use persisted position
5. Merge: persisted cities + session-derived cities = full city set

**Key insight:** Persisted cities are the base layer. Session activity overlays fiber counts and workers, but doesn't change position or existence.

### WebSocket Protocol

**New message types:**

```typescript
// Frontend → Server
{ type: 'pinCity', path: string, position: HexCoord }
{ type: 'unpinCity', cityId: string }

// Server → Frontend
{ type: 'cityPinned', city: City }
{ type: 'cityUnpinned', cityId: string, hadSessions: boolean }
{ type: 'confirmUnpin', cityId: string, sessionCount: number }  // If sessions present
```

### Frontend: Right-Click Context Menu

**ZoneRenderer changes:**
- Track right-click on canvas
- On right-click empty hex: show context menu at cursor position
- Menu option: "Add City Here"
- On click: prompt for path (native `prompt()` or custom modal)
- Send `pinCity` message with hex position

**On city hex right-click:**
- Menu option: "Remove City"
- If city has sessions: show warning first ("City has N active sessions. Remove anyway?")
- Send `unpinCity` message

### Visual Distinction

Persisted cities without active sessions could have subtle visual difference:
- Slightly desaturated hex color?
- Or just treat them identically — simpler

**Decision:** Treat identically for v1. The persistence is infrastructure, not UI chrome.

### Delete Flow

When unpinning a city with active sessions:
1. Server sends `confirmUnpin` with session count
2. Frontend shows confirmation dialog
3. User confirms → server unpins AND closes sessions (or just unpins and lets city become session-derived?)

**User chose:** "warn, then close sessions too" — so unpinning a city with sessions closes those sessions.

Actually, we can't close tmux sessions from hexarchy. Revised:
- Unpin removes persistence
- City remains while sessions exist (becomes session-derived again)
- When last session leaves, city disappears

The "warn" is just informing the user that sessions will continue until they exit.

## Context

@server/src/CityManager.ts — current city lifecycle, position assignment
@server/src/index.ts — buildState(), WebSocket handlers, rebuildCities()
@src/render/ZoneRenderer.ts — hex rendering, click handling
@src/ui/CityPanel.ts — city detail panel (may add unpin button here too)
@src/main.ts — WebSocket connection, message handling

## Completion

**Verify by doing:**

1. Start hexarchy with no sessions → persisted cities appear on map
2. Right-click empty hex → "Add City Here" → enter path → city appears at that hex
3. Kill all sessions in a persisted city → city remains
4. Start session in persisted city's path → session appears as worker, city position unchanged
5. Right-click persisted city → "Remove City" → if sessions, shows warning → city removed from persistence
6. Restart server → persisted cities reload correctly
7. Tests pass (add tests for CityPersistence)
