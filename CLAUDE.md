# hexarchy-v2

A spatial map for Claude sessions. Click to go there. That's it.

## What This Is

Hex grid showing:
- **Cities** = project directories (ephemeral — derived from active sessions)
- **Workers** = tmux sessions running Claude (ephemeral, clustered around their city)
- **Fiber badges** = count of open concerns per city

Click a worker → Kitty focuses that session's tab. Work happens in terminal, not in hexarchy.

## What This Is Not

Not a chat interface. Not a dashboard. Not a reskin of the terminal. The original hexarchy (`../hexarchy/`) inherited complexity from vibecraft — characters, stations, sound, chat rendering, 14,000 LOC. This is a clean rebuild at ~1,300 LOC.

## Architecture

See `ARCHITECTURE.md` for full details. Key points:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    Server    │────▶│   Browser    │────▶│    Kitty     │
│ SessionTracker│     │  Hex Grid    │     │  Tab Focus   │
│ CityManager  │     │  ZoneRenderer│     │              │
│ FiberReader  │     │  Store       │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

- **Server** watches tmux sessions, tracks cities, counts fibers
- **Browser** renders hex grid, handles clicks
- **Kitty** receives focus commands via `kitty @`

## Tech Stack

- **Frontend**: Three.js (hex rendering), TypeScript, Vite
- **Server**: Node.js, WebSocket (ws)
- **Terminal**: Kitty with remote control enabled

## Kitty Setup

```bash
# In ~/.config/kitty/kitty.conf
allow_remote_control yes
listen_on unix:/tmp/kitty-socket

# Or launch with
kitty --listen-on unix:/tmp/kitty-socket
```

## Visual Language

Cartographic Warmth — ancient, sun-bleached, archaeological. Not a dashboard, a map.

- **Sand** (#E8DCC4): background, idle hexes
- **Ochre** (#C4956A): city hexes
- **Umber** (#6B5344): labels, borders
- **Sepia** (#8B7355): secondary text

No bright colors. No animations. Information-dense, visually quiet.

## Context Pointers

| What | Where |
|------|-------|
| Original hexarchy (v1) | `/Users/cd280747/Documents/projects/hexarchy/` |
| Vibecraft bundle | `/Users/cd280747/Documents/projects/hexarchy/vibecraft-dist/` |
| Cartographic Warmth spec | `/Users/cd280747/Documents/projects/hexarchy/docs/cartographic-warmth.md` |
| Felt (fiber system) | `~/loom/.felt/` (global), `.felt/` (per-project) |
| HexGrid math (port) | `/Users/cd280747/Documents/projects/hexarchy/src/scene/HexGrid.ts` |
| Session tracking (port) | `/Users/cd280747/Documents/projects/hexarchy/server/index.js` ~L800-1200 |
| Hex math reference | [Red Blob Games](https://www.redblobgames.com/grids/hexagons/) |
| Aspirational visual | [threejs-hex-map](https://github.com/Bunkerbewohner/threejs-hex-map) — Civ-like polish |

## Build Order

1. Project setup (vite, three, ws)
2. Server: SessionTracker, CityManager, FiberReader, WebSocket
3. State: Store, types
4. Render: HexGrid, ZoneRenderer, Camera
5. Terminal: Kitty focus integration
6. Bootstrap: main.ts wiring

## Decisions

| Question | Answer |
|----------|--------|
| City persistence | None — cities derived from sessions, exist while ≥1 session has that cwd |
| Attention indicator | None for now |
| Fiber display | Badge count on city hex |
| Chat rendering | None — terminal handles interaction |
| Status colors | None — all hexes same color |
| Characters/avatars | Cut |
| Stations | Cut |
| Sound | Cut |
| Voice | Cut |
| Hex orientation | Pointy-top (`angle = π/3 * i - π/2`) to match axialToCartesian spacing |
| Camera | PerspectiveCamera at 45° angle, 45° rotation — Civ-like diagonal view |
| Camera drag | Sieve (screenToWorld projection) — clicked tile stays under cursor |
| Visual polish | Shadows + random elevation + edge lines for depth (not full v1 port) |

## Hex Geometry

**Gotcha:** axialToCartesian uses pointy-top spacing formula. All hex shape code must use `-π/2` angle offset or you get triangle gaps between hexes.

```typescript
// CORRECT (pointy-top)
const angle = (Math.PI / 3) * i - Math.PI / 2

// WRONG (flat-top) — causes gaps with pointy-top spacing
const angle = (Math.PI / 3) * i
```

Reference: [Red Blob Games hex guide](https://www.redblobgames.com/grids/hexagons/)

## Server Gotchas

**Worker hex positions must be absolute, not relative.** `CityManager.assignWorkerHex()` returns positions relative to (0,0). Before sending to frontend, `buildState()` must offset by city position: `city.position.q + workerHex.q`. Otherwise workers from different cities overlap at origin.

**Kitty launch needs `--cwd`.** When creating new tab with `kitty @ launch`, include `--cwd=${session.cwd}` so terminal starts in correct directory. Without this, `tmux attach` works but the tab's working directory is wrong.

## Running

```bash
# Both (recommended) — cleans ports, runs frontend + backend
./dev.sh

# Or separately:
cd server && npm run dev    # WebSocket on :4004
npm run dev                 # Vite on :5173

# Tests
cd server && npm test       # 80 tests

# Kitty must be running with remote control enabled
```

## Camera Controls

- **Drag**: Sieve behavior — world point under mouse stays fixed (uses screenToWorld projection)
- **Scroll**: Zoom in/out
- **Arrow keys**: Pan (↑↓←→)
- **Click city**: Focus camera on city
- **Click worker**: Focus Kitty tab
