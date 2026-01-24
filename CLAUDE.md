# hexarchy-v2

A spatial map for Claude sessions. Click to go there. That's it.

## What This Is

Hex grid showing:
- **Cities** = project directories (ephemeral — derived from active sessions)
- **Workers** = tmux sessions running Claude (ephemeral, clustered around their city)
- **Fiber badges** = count of open concerns per city

Click a worker → Kitty focuses that session's tab. Work happens in terminal, not in hexarchy.

## What This Is Not

Not a chat interface. Not a dashboard. Not a reskin of the terminal. The original hexarchy (`../hexarchy/`) inherited complexity from vibecraft — characters, stations, sound, chat rendering, 14,000 LOC. This rebuild is ~6,200 LOC.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         SERVER                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ SessionTracker  │  │  CityManager    │  │ FiberReader │ │
│  │ GitStatusManager│  │ CityPersistence │  │OriginManager│ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │  HttpApi        │  │  MessageRouter  │  │ KittyInteg  │ │
│  │  (claims proxy) │  │  (WS dispatch)  │  │ (terminal)  │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│                         index.ts                           │
│              (wiring, state build, broadcast)              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        BROWSER                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   ZoneRenderer  │  │     Camera      │  │   HexGrid   │ │
│  │   (3D hexes)    │  │  (controls)     │  │   (math)    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │    CityPanel    │  │   ContextMenu   │  │ ViewSwitcher│ │
│  │   (fibers UI)   │  │  (right-click)  │  │ (Map/Plots) │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│                          main.ts                           │
│              (scene setup, event handlers)                 │
└─────────────────────────────────────────────────────────────┘

Server Modules (~3,400 LOC):
- SessionTracker: tmux polling, session discovery
- CityManager: city lifecycle, worker hex allocation
- CityPersistence: ~/.hexarchy/cities.json
- OriginManager: remote agent tracking
- GitStatusManager: local git diff tracking
- FiberReader: felt integration
- EventWatcher: Claude activity events
- HttpApi: claims dashboard proxy, city activation
- MessageRouter: WebSocket message dispatch
- KittyIntegration: terminal focus, new workers, handoff
- index.ts: wiring and state management

Browser Modules (~2,800 LOC):
- ZoneRenderer: hex meshes, labels, activity decals
- Camera: sieve drag, zoom, key pan
- HexGrid: axial coordinate math
- CityPanel: fiber list, search, markdown/KaTeX
- ContextMenu: right-click actions
- ViewSwitcher/ViewOverlay: Map/Plots/Plans modes
- main.ts: Three.js setup, WebSocket, event routing
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

**Porch Morning** palette — warm, antiquarian, cartographic. Like an old map or field notes.

### Colors (CSS vars in index.html)

| Name | Hex | Use |
|------|-----|-----|
| `--bg-primary` | #C8B8A8 | Ground plane, map background |
| `--bg-card` | #EDE8E0 | Panels |
| `--bg-elevated` | #FDFCFA | Elevated UI elements |
| `--text-primary` | #2E2A26 | Main text |
| `--text-secondary` | #4A4540 | Secondary text |
| `--text-muted` | #7A7368 | Muted text |
| `--gold` | #9A7B35 | City hexes, accents |
| `--accent` | #5A7B7B | Teal — working state |

### Typography

- **EB Garamond** — body, display (with small-caps for headers)
- **JetBrains Mono** — code, monospace

### Labels & Banners

Map labels use **3-slice** technique with Nano Banana generated assets. Different banner styles per entity type:

| Entity | Banner | Text Color | Slice Width | Style |
|--------|--------|------------|-------------|-------|
| **City** | `banner.png` | #4A1515 (blood red) | 40px | Parchment, cartographic, torn edges |
| **Worker** | `worker-banner.png` | #3D2817 (dark brown) | 150px | Leather patch, tool icons, guild aesthetic |

**3-slice terminology:**
- **Left/Right caps** (sliceWidth): Fixed decorative ends, never stretch
- **Middle**: Stretches horizontally to fit text
- Larger sliceWidth = more decorative detail visible

**Sizing is dynamic:**
- Width based on text length + padding
- Height based on fontSize + vertical padding
- `worldHeight` parameter controls 3D scale

See `ZoneRenderer.createLabel()` for implementation.

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

## Server Module Responsibilities

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

## Decisions

| Question | Answer |
|----------|--------|
| City persistence | Auto-persist to `~/.hexarchy/cities.json`; dormant cities show muted |
| Fiber display | CityPanel with search, expand/collapse — no badge on map |
| Chat rendering | None — terminal handles interaction |
| Worker status colors | Hex color varies (idle=muted, working=teal, attention=red) |
| Characters/avatars | Cut |
| Stations | Cut |
| Sound | Cut |
| Voice | Cut |
| Hex orientation | Pointy-top (`angle = π/3 * i - π/2`) to match axialToCartesian spacing |
| Camera | PerspectiveCamera at 45° angle, 45° rotation — Civ-like diagonal view |
| Camera drag | Sieve (screenToWorld projection) — clicked tile stays under cursor |
| Labels | Billboard sprites (always face camera), 3-slice scroll banners |
| Visual assets | Generated via Nano Banana, composited with text in canvas |
| Visual polish | Porch Morning palette, antiquarian aesthetic throughout |

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

**Local vs remote data pattern.** For features that work on both local and remote cities:
- Local: Use a manager class that polls (e.g., GitStatusManager tracks city paths)
- Remote: Agent collects data, sends via WebSocket, server stores in a separate cache (e.g., `remoteGitStatuses` Map keyed by `originId:path`)
- `buildState()` merges both sources when building city data

**Test mocks must include all child_process functions.** `index.test.ts` mocks `child_process`. When adding new code that imports functions like `execFile`, add them to the mock or tests fail with "No export defined on mock".

**Kitty focus requires exact title match.** Use regex anchors `^session$` to avoid "loom" matching "loom remote". The `focusSession()` function uses `--match title:${shellEscape('^' + tmuxSession + '$')}`.

**Remote workers need SSH tunnel.** The hexarchy-agent connects to `localhost:4004` which must be tunneled from the local machine. Requires `RemoteForward 4004 127.0.0.1:4004` in SSH config. If using ControlMaster, run `ssh -O exit <host>` to reset the control socket when adding new forwards.

**Remote cities persist sshHost.** Cities store `sshHost` (SSH config name like "candide") separately from `originId` (hostname like "remote-c02"). This allows activating dormant cities when the agent isn't connected.

**New workers on remote cities.** `handleNewWorker()` detects remote cities and SSHs to create tmux session there, then opens Kitty tab with `ssh -t <host> tmux attach`. Uses `bash -l -c` for login shell (nvm/node in PATH).

**Agent excludes itself.** The hexarchy-agent skips sessions named "hexarchy-agent" to avoid appearing as a worker on the map.

**Multi-node HPC systems.** For HPC clusters with multiple login nodes (like cineca Leonardo):
- Agent constructs specific SSH alias: `cineca` + `login05` → `cineca-login05`
- SSH config maps aliases to specific nodes: `cineca-login05` → `login05-ext.leonardo.cineca.it`
- Cities are keyed by base sshHost (`remote-cineca:/path`) so different nodes share cities
- `CityManager.setOriginSshHost()` normalizes keys; city `originId` updates when accessed from different node

**Kitty tabs need SSH_AUTH_SOCK.** Kitty tabs don't inherit SSH agent. Pass explicitly:
```typescript
const sshAuthSock = process.env.SSH_AUTH_SOCK ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` : '';
kitty @ launch --type=tab ${sshAuthSock} ...
```
Without this, SSH fails with "Permission denied" even with valid agent keys/certificates.

**Shell escaping for SSH+tmux+bash chains.** Avoid nesting `shellEscape()` calls — creates quote soup. Use double quotes for inner command:
```typescript
// WRONG — nested escaping breaks
const cmd = `felt on ${shellEscape(fiberId)} && claude`;
const tmux = `tmux new-session ... 'bash -l -c ${shellEscape(cmd)}'`;

// RIGHT — double quotes for inner, single shellEscape on outer
const tmux = `tmux new-session ... 'bash -l -c "felt on ${fiberId} && claude"'`;
const ssh = `ssh -T host ${shellEscape(tmux)}`;
```

**Local kitty tabs lose title with bash -c.** The `--title` flag only sets initial title; running process overwrites it. Use tmux even locally for title stability — matches remote pattern, focus-tab works reliably.

**Binary files need base64 data URL.** PDFs, images can't be read as UTF-8 text. HttpApi checks extension, fetches as buffer (local) or via `ssh base64` (remote), returns `{ type, url: 'data:mime;base64,...' }`. FileViewerModal displays in `<iframe>` (PDF) or `<img>`.

## Running

```bash
# Both (recommended) — cleans ports, runs frontend + backend
./dev.sh

# Or separately:
cd server && npm run dev    # WebSocket on :4004
npm run dev                 # Vite on :5173

# Tests
cd server && npm test       # ~100 tests

# Kitty must be running with remote control enabled
```

## Camera Controls

- **Drag**: Sieve behavior — world point under mouse stays fixed (uses screenToWorld projection)
- **Scroll**: Zoom in/out
- **Arrow keys**: Pan (↑↓←→)
- **Click city**: Focus camera on city, open CityPanel
- **Click worker**: Focus Kitty tab
- **Right-click worker**: Context menu (Focus Tab, Kill Worker)
- **Right-click city**: Context menu (New Worker, Remove City)
- **Right-click empty**: Add City Here (or New Worker if near existing city)

## File Search

CityPanel includes filesystem search per city:

- **Name mode**: Search filenames (uses `fd`, falls back to `find | grep`)
- **Content mode**: Search file contents (uses `rg`, falls back to `grep -r`)
- 150ms debounce, cancels stale searches, max 50 results
- Click result → opens FileViewerModal
- Works on remote cities via SSH

**Requires:** `brew install fd ripgrep` (optional but faster)

## Remote Agent

The hexarchy-agent runs on remote machines and sends session data via SSH tunnel.

### Installation

```bash
# Install agent + hooks on remote machine
./scripts/install-remote.sh candide

# Or install and start immediately
./scripts/install-remote.sh candide --start
```

The install script:
1. Copies `hexarchy-hook.sh` to `~/.hexarchy/hooks/`
2. Copies `agent.js` to `~/bin/hexarchy-agent.js`
3. Installs `ws` npm package
4. Patches `~/.claude/settings.json` to add hooks
5. Optionally starts the agent

**Prerequisites on remote:** Node.js, jq, tmux, Claude Code

### Manual Management

```bash
# Start agent manually on remote:
ssh candide
tmux new-session -d -s hexarchy-agent "node ~/bin/hexarchy-agent.js connect --ssh-host=candide"

# Check status
tmux capture-pane -t hexarchy-agent -p

# Update agent (from local)
scp server/agent.js candide:~/bin/hexarchy-agent.js
```

### SSH Tunnel

**Requires:** SSH tunnel with `RemoteForward 4004 127.0.0.1:4004` in local `~/.ssh/config`.

### Code Sync Notes

**Detection logic:** Both `SessionTracker.ts` and `agent.js` check if pane process IS claude (via `ps -o comm=`) before checking children. Keep in sync — see comments in each file.

**Activity summary:** `extractSummary()` in `activityUtils.ts` is source of truth. Copy in `agent.js` must stay in sync (agent runs standalone, can't import).

**Session name truncation:** Long tmux names (e.g., `ralph-global-views-map-plots-plans-3374f8fb`) are truncated for UI display via `SessionTracker.truncateName()`. Ralph sessions become `ralph-{hash}`, others become `first8…last8`. Full `tmuxSession` preserved for routing.

## Persistent Cities

Cities auto-persist to `~/.hexarchy/cities.json` when first seen. Dormant cities (no active workers) show with muted color. Click dormant remote city → `POST /activate-city` → SSH starts hexarchy-agent.

## Asset Generation (Nano Banana)

For visual assets that need to look hand-crafted (scrolls, banners, decorative elements), use Nano Banana.

### Transparency via Difference Matting

**Nano Banana cannot output true transparency.** The workaround:

```bash
# 1. Generate on WHITE background
gemini --yolo "/generate 'your asset on SOLID PURE WHITE #FFFFFF background. No text.'"

# 2. Edit to BLACK background
gemini --yolo --resume latest -p "/edit asset.png 'Change white background to SOLID PURE BLACK #000000. Keep everything else EXACTLY unchanged.'"

# 3. Extract alpha mathematically
npx tsx scripts/extract_alpha.ts white.png black.png public/asset.png
```

The math: pixels that look identical on white and black are opaque; pixels that show the background are transparent; everything else is semi-transparent. Script handles AI variation noise with threshold.

### Prompt Patterns

- **For compositing**: "on SOLID PURE WHITE #FFFFFF background"
- **Clean center**: "Empty center for text overlay"
- **No AI text**: "No text, no letters, no writing"
- **Style direction**: "Illustrated, Civilization game style" vs "NOT photographic"
- **Aspect ratio**: "Wide rectangular, roughly 5:1 aspect ratio"

### Current Assets

| Asset | Purpose | Prompt Style |
|-------|---------|--------------|
| `banner.png` | City labels | Parchment, cartographic, torn edges |
| `worker-banner.png` | Worker labels | Leather patch, tool icons, guild/craftsman |

### Terrain Background Map

8K terrain map on ground plane, LOD pyramid for performance.

**Current assets:**
- `terrain.png` — 2K default (7.8MB)
- `terrain_1k.png` through `terrain_8k.png` — LOD pyramid
- `terrain_full.png` — 8K source (104MB) in nanobanana-output/

**Generation pipeline (outpaint + optimal blend):**
1. Generate center tile at 4K via Gemini 3 Pro API
2. Outpaint N/S/E/W: give Gemini half of center, ask to extend
3. Find optimal overlap via MSE minimization (~2048px, search 2040-2060)
4. 2D search: also vary vertical offset (±20px) for 30-40% better alignment
5. Gradient blend: `output = A*(1-gradient) + B*gradient` over overlap
6. Fill corners: show Gemini narrow-band context (two adjacent edges), not full region

**Key patterns:**
- **Optimal overlap**: MSE between edge strips, minimum = best alignment
- **Narrow-band context**: 512px strips work better than 2048px halves for Gemini
- **Corner infill**: show just the two edges that need connecting

**Style:** Civ 6/7 aesthetic — photorealistic aerial but painterly, "wow that could exist." Top-down nadir view, hot air balloon altitude. Southwest lighting.

**Scripts:** `scripts/generate_terrain_4k.py` — API-based terrain generation with tile prompts.

### Per-Hex Tile Sprites (Alternative)

For individual hex terrain types, same transparency workflow applies:
1. Generate tile set on white (grass, forest, mountain, water, etc.)
2. Edit each to black
3. Extract alpha
4. Load as texture atlas or individual sprites

Consider:
- **Texture atlas**: Pack tiles into single image, UV map in shader
- **Instanced rendering**: One geometry, many instances with different textures
- **Edge blending**: Tiles need to blend at edges (see threejs-hex-map techniques)

### File Locations

- `nanobanana-output/` — Generated images (gitignored)
- `public/` — Production assets
- `scripts/extract_alpha.ts` — Transparency extraction

## CityPanel

Right-side panel showing fibers for selected city. Styled with **Antiquarian Field Notes** aesthetic:

- Parchment texture with ruled lines
- Gold accent border at top
- Kind-specific color coding (task=teal, decision=gold, spec=purple, question=green)
- Search/filter, expand/collapse, handoff buttons
- Staggered fade-in animations

Files: `src/ui/CityPanel.ts`, CSS in `index.html`
