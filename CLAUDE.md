# hexarchy-v2

Spatial map for Claude sessions. Click to go there.

## Core Concepts

- **Cities** = project directories (derived from active sessions, persist when dormant)
- **Workers** = tmux sessions running Claude (clustered around their city hex)
- **Fibers** = open concerns per city (from felt)

Click worker → Kitty focuses that tab. Work happens in terminal, not here.

## Running

```bash
./dev.sh                    # Frontend + backend (recommended)
cd server && npm test       # ~100 tests
```

Requires Kitty with `allow_remote_control yes` and `listen_on unix:/tmp/kitty-socket`.

## Architecture

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer (hex meshes)
├── CityManager               ├── Camera (sieve drag)
├── OriginManager (remote)    ├── CityPanel (fibers, search)
├── FiberReader               ├── ContextMenu
├── KittyIntegration          └── main.ts
└── index.ts (state, WS)
```

Server polls tmux → builds state → broadcasts. Browser renders → user clicks → routes to Kitty.

## Visual Language

**Porch Morning** — warm, antiquarian, cartographic.

| Element | Value |
|---------|-------|
| Background | #C8B8A8 (map), #EDE8E0 (panels) |
| Text | #2E2A26 primary, #7A7368 muted |
| Accents | #9A7B35 gold (cities), #5A7B7B teal (working) |
| Fonts | EB Garamond (body), JetBrains Mono (code) |

Labels use 3-slice banners (parchment for cities, leather for workers).

## Key Decisions

| Cut | Kept |
|-----|------|
| Chat rendering | Terminal handles it |
| Characters/avatars | — |
| Sound, voice | — |
| Stations | — |

This is navigation, not interaction. ~6,200 LOC vs original's 14,000.

## Hex Geometry

Pointy-top orientation. All hex angles need `-π/2` offset:
```typescript
const angle = (Math.PI / 3) * i - Math.PI / 2  // correct
```

Reference: [Red Blob Games](https://www.redblobgames.com/grids/hexagons/)

## Detailed Docs (Fibers)

```bash
felt find hexarchy              # All docs
felt show <fiber-id>            # Full content
```

| Topic | Command |
|-------|---------|
| Architecture | `felt find hexarchy-architecture` |
| Visual Design | `felt find hexarchy-visual` |
| Remote Agent | `felt find hexarchy-remote` |
| Asset Generation | `felt find hexarchy-assets` |
| Gotchas | `felt find hexarchy-gotchas` |
