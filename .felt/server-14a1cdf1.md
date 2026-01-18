---
title: '[hexarchy-v2] Server'
status: closed
kind: spec
priority: 2
created-at: 2026-01-18T00:23:58.886859+01:00
closed-at: 2026-01-18T02:06:37.968031+01:00
close-reason: 'Server complete. Implemented: SessionTracker (polls tmux every 2s, filters Claude sessions via pgrep, fires change callbacks), CityManager (hex positioning with 3-tile minimum spacing, longest-prefix path matching, worker hex spirals, cities.json persistence), FiberReader (YAML frontmatter parsing, handles quoted status values), index.ts (HTTP + WebSocket on :4004, focus commands via Kitty @, 10s fiber refresh, 5s startup grace period for orphan cleanup). 58 tests across 4 suites cover edge cases: nested paths, rapid session changes, malformed tmux/YAML, shell escaping, concurrent WebSocket clients. Build passes, server starts correctly.'
---

## Goal

Backend that watches tmux sessions, tracks cities, counts fibers, and pushes state over WebSocket.

## Design

### Data Flow

```
tmux sessions
     │
     ▼
┌─────────────────┐
│ SessionTracker  │  polls tmux, parses pane pwd
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  CityManager    │  maps sessions → cities by path prefix
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  FiberReader    │  counts open fibers per city path
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   WebSocket     │  pushes { cities, sessions } to browser
└─────────────────┘
```

### Files

```
server/
  index.ts          # HTTP server + WebSocket setup, wiring
  SessionTracker.ts # Watch tmux sessions, parse pwd
  CityManager.ts    # City CRUD, hex position assignment, persistence
  FiberReader.ts    # Count open fibers per city
```

### SessionTracker

Polls `tmux list-panes -a -F '#{session_name}:#{pane_pid}:#{pane_current_path}'` on interval.

Returns:
```typescript
interface Session {
  id: string           // tmux session name
  name: string         // display name
  cwd: string          // pane_current_path
  cityId: string | null
}
```

**Port from:** `@hexarchy/server/index.js` L800-1000 (session tracking logic)

### CityManager

Cities are project directories with hex positions. Stored in `~/.hexarchy/cities.json`.

```typescript
interface City {
  id: string
  path: string         // absolute filesystem path
  name: string         // display name
  position: { q: number, r: number }
  fiberCount?: number  // injected by FiberReader
}
```

Key methods:
- `getCities()` — all cities
- `addCity(path, name?, position?)` — create city, auto-assign hex if needed
- `removeCity(id)` — delete city
- `findCityForPath(cwd)` — longest prefix match
- `assignWorkerHex(cityId)` — spiral outward from city center

**City lifecycle:**
- Auto-created when a session's pwd matches no existing city
- Auto-removed when no sessions have pwds matching that city (ephemeral by default)

**Port from:** `@hexarchy/server/CitiesManager.js` (complete class, adapt lifecycle)

### FiberReader

Counts open fibers for a city by reading its `.felt/` directory.

```typescript
function countOpenFibers(cityPath: string): number {
  // Read .felt/*.md files
  // Parse frontmatter, count where status !== 'closed'
}
```

Simple. ~30 lines.

### WebSocket Protocol

Server pushes on:
- Initial connection
- Session change (new/removed/moved)
- City change (added/removed/repositioned)
- Fiber count change (on interval or felt hook)

Payload:
```typescript
interface StateUpdate {
  cities: City[]
  sessions: Session[]
}
```

Client sends:
- `{ type: 'focus', sessionId: string }` — request to focus a session (server calls Kitty)

### index.ts

Wires everything:
- Express for static file serving (or just use Vite in dev)
- WebSocket server on same port
- SessionTracker polling loop
- Broadcast on state change

---

## Verification (back pressure)

When you think you're done, test the system:

- Start the server. Does it run?
- Create tmux sessions in various directories. Do they appear?
- Kill sessions. Do they disappear? Do orphaned cities get cleaned up?
- Try edge cases: nested paths, rapid session creation/deletion, malformed tmux output
- Connect a WebSocket client. Does it receive state? Updates?
- Try the focus message. Does Kitty respond?

If anything fails or feels incomplete, that's your contribution. Fix it.

---

## Stopping Criteria

You may ONLY close this fiber when:

1. You have thoroughly explored the implementation
2. You have tested normal paths AND edge cases
3. A full pass yields nothing to implement, fix, or improve
4. No edits were made in that final pass

If you made any edit, exit and let the loop continue. Only close when there's genuinely nothing left to do.
