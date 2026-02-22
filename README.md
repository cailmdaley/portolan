# Portolan

Spatial map for development sessions. Cities are projects, workers are Claude instances, fibers are open concerns. Click to navigate.

**[Live Research Dashboard](https://cailmdaley.github.io/portolan/)** — interactive DAG of research fibers with staleness tracking and artifact images.

## Running

```bash
./dev.sh          # Frontend (Vite :5173) + backend (Node :4004)
```

Requires [Kitty](https://sw.kovidgoyal.net/kitty/) with `allow_remote_control yes` and `listen_on unix:/tmp/kitty-socket`.

## Static Dashboard

Export the research rhizome as a static page for GitHub Pages:

```bash
# With the portolan server running:
npm run export:rhizome -- pure-eb    # Download data + artifacts
npm run build:static                 # Build → docs/
# Commit docs/ and push
```

Served from `/docs` on the `main` branch.

## Architecture

- **Server** (Node, `:4004`) — polls tmux, manages state, broadcasts via WebSocket
- **Browser** (Three.js, `:5173`) — hex map, camera, HUD, rhizome DAG viewer
- **Static** (`docs/`) — standalone rhizome build for GitHub Pages
