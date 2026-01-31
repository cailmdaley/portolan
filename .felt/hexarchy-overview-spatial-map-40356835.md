---
title: 'Hexarchy Overview: spatial map for Claude sessions'
status: closed
kind: spec
tags:
    - '[docs]'
priority: 2
created-at: 2026-01-25T15:26:33.860617+01:00
closed-at: 2026-01-31T00:56:47.466685+01:00
close-reason: Finalized documentation — referenced in CLAUDE.md Deep Dives.
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

## Related Specs

| Topic | Fiber |
|-------|-------|
| **Interactions** | `hexarchy-interactions-gesture-245370ce` — gestures, panels, UI |
| **Persistence** | `hexarchy-persistence-5335c979` — what survives restarts |
| **Architecture** | `hexarchy-architecture-server-361a92a2` — server/browser modules |
| **Visual Design** | `hexarchy-visual-design-palette-49cdf63d` — palette, typography, banners |
| **Remote Agent** | `hexarchy-remote-agent-setup-ssh-b7ce007f` — SSH tunnels, multi-node |
| **Assets** | `hexarchy-assets-nano-banana-aec3aef3` — Nano Banana generation |
