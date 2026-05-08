# Portolan

Spatial map for development sessions. Cities are projects, workers are Claude instances, fibers are open concerns. Click to navigate.

## Running

```bash
./dev.sh          # Frontend (Vite :5173) + backend (Node :4004)
```

```bash
./scripts/install-session-start-hooks.sh # Register the city-list SessionStart hook for Claude and Codex
```

Requires [Kitty](https://sw.kovidgoyal.net/kitty/) with `allow_remote_control yes` and `listen_on unix:/tmp/kitty-socket`.

## Architecture

- **Server** (Node, `:4004`) — polls tmux, manages state, broadcasts via WebSocket
- **Browser** (Three.js, `:5173`) — hex map, camera, map chrome, and vellum workspace
- **Vellum** — shared reader/editor shell for fibers, files, kanban, and find
