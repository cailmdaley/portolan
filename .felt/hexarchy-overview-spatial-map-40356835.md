---
title: 'Hexarchy Overview: spatial map for Claude sessions'
status: open
kind: spec
tags:
    - '[docs]'
priority: 2
created-at: 2026-01-25T15:26:33.860617+01:00
---

A spatial map for Claude sessions. Click to go there. That's it.

## What This Is

Hex grid showing:
- **Cities** = project directories (ephemeral — derived from active sessions)
- **Workers** = tmux sessions running Claude (clustered around their city)
- **Fiber badges** = count of open concerns per city

Click a worker → Kitty focuses that session's tab. Work happens in terminal, not here.

## What This Is Not

Not a chat interface. Not a dashboard. Not a reskin of the terminal. Original hexarchy inherited complexity from vibecraft (14,000 LOC). This rebuild is ~6,200 LOC.

## Tech Stack

- **Frontend**: Three.js (hex rendering), TypeScript, Vite
- **Server**: Node.js, WebSocket (ws)
- **Terminal**: Kitty with remote control enabled

## Running

```bash
./dev.sh                    # Both frontend + backend (recommended)
cd server && npm run dev    # WebSocket on :4004
npm run dev                 # Vite on :5173
cd server && npm test       # ~100 tests
```

## Controls

- **Drag**: Sieve — clicked point stays under cursor
- **Scroll**: Zoom
- **Arrow keys**: Pan
- **Click city**: Focus camera, open CityPanel
- **Click worker**: Focus Kitty tab
- **Right-click**: Context menu (new worker, remove city, etc.)

## Related Specs

- `felt find hexarchy-architecture` — server/browser modules
- `felt find hexarchy-visual` — palette, typography, banners
- `felt find hexarchy-remote` — agent setup, SSH tunnels
- `felt find hexarchy-assets` — Nano Banana generation
- `felt find hexarchy-gotchas` — critical bugs to avoid
