---
title: 'Hexarchy Architecture: server/browser modules and data flow'
status: open
kind: spec
tags:
    - '[docs]'
priority: 2
depends-on:
    - hexarchy-overview-spatial-map-40356835
created-at: 2026-01-25T15:26:41.280746+01:00
---

## Data Flow

```
Server watches tmux → builds state → broadcasts via WebSocket
Browser renders state → user clicks → server routes to Kitty
```

## Server Modules (~3,400 LOC)

| Module | Purpose |
|--------|---------|
| `index.ts` | Wire managers, build/broadcast state, WebSocket server |
| `SessionTracker` | Poll tmux for Claude sessions, detect changes |
| `CityManager` | City lifecycle from cwds, worker hex allocation |
| `CityPersistence` | Save/load cities to `~/.hexarchy/cities.json` |
| `OriginManager` | Track remote agent connections, compass positions |
| `GitStatusManager` | Local git status polling |
| `FiberReader` | Read felt fibers from project directories |
| `EventWatcher` | Watch Claude activity events (tool use) |
| `HttpApi` | HTTP endpoints (claims proxy, city activation) |
| `MessageRouter` | Dispatch WebSocket messages to handlers |
| `KittyIntegration` | Terminal commands (focus, new worker, handoff) |

## Browser Modules (~2,800 LOC)

| Module | Purpose |
|--------|---------|
| `ZoneRenderer` | Hex meshes, labels, activity decals |
| `Camera` | Sieve drag, zoom, key pan |
| `HexGrid` | Axial coordinate math |
| `CityPanel` | Fiber list, search, markdown/KaTeX |
| `ContextMenu` | Right-click actions |
| `ViewSwitcher` | Map/Plots/Plans modes |
| `main.ts` | Three.js setup, WebSocket, event routing |

## Key Patterns

**Local vs remote data**: Local uses manager classes that poll. Remote agent sends data via WebSocket, server stores in separate cache (e.g., `remoteGitStatuses`). `buildState()` merges both.

**City persistence**: Auto-persist to `~/.hexarchy/cities.json`. Dormant cities (no workers) show muted. Click dormant remote → SSH starts agent.

**File search**: CityPanel has per-city search. Uses `fd`/`rg` locally, SSH for remote. Filename-only for remote (content too slow).
