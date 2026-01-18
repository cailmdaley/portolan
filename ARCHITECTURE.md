# Hexarchy Architecture

> A spatial map for Claude sessions. Click to go there. That's it.

## The Core Loop

1. See hex grid with cities (projects) and workers (sessions)
2. Click a worker
3. Kitty focuses that session's tab
4. Work happens in terminal

Hexarchy is a **navigation layer**, not an interaction layer.

## What Falls Away

| Cut | Why |
|-----|-----|
| Chat rendering | Interaction happens in terminal |
| Token tracking | Visible in terminal |
| Question/permission modals | Answered in terminal |
| Activity feed | Visible in terminal |
| Timeline | Not needed for navigation |
| Characters/avatars | Decoration |
| Stations | Decoration |
| Sound | Decoration |
| Voice input | Interaction, not navigation |
| Status indicators (idle/working/blocked) | Not actionable from the map |
| Session output streaming | Nothing to render it into |

**~8,000 LOC eliminated.** What remains is maybe 1,500 LOC.

## What Remains

### Frontend (~800 LOC estimate)

```
src/
  main.ts           # Bootstrap, event loop (~100)

  state/
    store.ts        # Cities, sessions, selection (~150)
    types.ts        # Interfaces (~50)

  render/
    HexGrid.ts      # Coordinate math (~100)
    ZoneRenderer.ts # Hex meshes, labels (~300)
    Camera.ts       # Pan, zoom, focus (~100)

  terminal/
    kitty.ts        # focus-tab, launch (~50)
```

### Server (~500 LOC estimate)

```
server/
  index.ts          # HTTP + WebSocket setup (~100)
  SessionTracker.ts # Watch tmux sessions (~200)
  CityManager.ts    # City CRUD, hex positions (~150)
  FiberReader.ts    # Count open fibers per city (~50)
```

### The Render

- Hex grid (Cartographic Warmth palette)
- City hexes: project name, fiber count badge
- Worker hexes: session name, positioned around city
- Selected state: subtle highlight
- That's it. No animations. No particles. No status colors.

## Kitty Integration

**Config required** (`~/.config/kitty/kitty.conf`):
```
allow_remote_control yes
listen_on unix:/tmp/kitty-socket
```

**Or launch with:**
```bash
kitty --listen-on unix:/tmp/kitty-socket
```

**Click handler:**
```typescript
// terminal/kitty.ts
import { execSync } from 'child_process';

export function focusSession(sessionName: string): void {
  const socket = process.env.KITTY_LISTEN_ON || 'unix:/tmp/kitty-socket';

  try {
    // Try to focus existing tab
    execSync(`kitty @ --to ${socket} focus-tab --match title:${sessionName}`);
  } catch {
    // No tab — create one
    execSync(`kitty @ --to ${socket} launch --type=tab --title=${sessionName} tmux attach -t ${sessionName}`);
  }

  // Bring Kitty to front
  execSync(`osascript -e 'tell app "kitty" to activate'`);
}
```

## Open Question: Attention

You said drop status indicators. But consider:

**The problem:** You have 5 sessions. One is waiting for a question answer. How do you know which one to click?

**Options:**

1. **No indicator** — You remember, or you click around until you find it
2. **Single status: attention** — Hexes are plain, except "needs you" gets vermillion border
3. **External signal** — macOS notification when session needs attention, hexarchy stays purely spatial

The first is pure. The second is minimal but useful. The third pushes attention out of hexarchy entirely.

## Data Flow

```
tmux sessions
     │
     ▼
┌─────────────────┐
│ SessionTracker  │ watches tmux, parses pwd
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  CityManager    │ maps sessions → cities by path prefix
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   WebSocket     │ pushes {cities, sessions} to browser
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Store       │ holds state
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  ZoneRenderer   │ draws hexes
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Click handler  │ → kitty.focusSession()
└─────────────────┘
```

## Migration Path

This isn't a refactor. It's a rebuild. The current codebase has ~14,000 LOC. The target has ~1,300 LOC.

**Option A: Scorched earth**
- New directory, start fresh
- Port only: HexGrid math, Kitty integration, server session tracking
- Cleaner, but loses any working pieces

**Option B: Aggressive deletion**
- Delete Character.ts, Station.ts, SoundManager.ts, all modals, feed, timeline
- Gut Scene.ts down to just hex rendering
- Gut main.ts down to just bootstrap + click handling
- Gut server/index.js into modules
- Messier process, but incremental

Given the scope of cuts, **Option A** (fresh start) might actually be faster and cleaner.

## Decisions

| Question | Answer |
|----------|--------|
| Attention indicator | None for now |
| Fiber display | Badge count on city hex |
| Migration | New directory, clean start, port what's easy |
