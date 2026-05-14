# Portolan

> A spatial map for your development sessions. Cities are projects; workers are
> Claude instances attached to them; fibers are open concerns. Click a worker to
> jump to that terminal tab.

Portolan is a navigation layer for active work. Deep work stays in the terminal
and in [Vellum](#related-projects); the map stays spatial. The goal is not a
chat UI or an IDE — it's a place to see *what's alive* across all of your
projects and route attention there with a click.

## Status: experimental, not packaged for use

This repository is shared as **inspiration, not as a product**. Some honest
caveats:

- It is in the middle of a TypeScript → Rust migration; the Node server and the
  `crates/` Rust workspace currently coexist.
- It depends on a sibling [`vellum-reader`](#related-projects) source tree
  (`file:../vellum`) that isn't yet published.
- It assumes a very specific local environment: macOS,
  [Kitty](https://sw.kovidgoyal.net/kitty/) with remote control, tmux, and a
  particular convention for project directories under `~/Documents/projects`.
- Several integration points (remote workers over SSH, the Shuttle dispatch
  daemon, the felt fiber store, the Reminders bridge) are wired to one author's
  setup.

If you want to try the underlying ideas — a spatial workspace map, terminal
focus routing, file/fiber co-rendering, agent-aware activity feeds — please
read, fork, and reuse freely. Pull requests are welcome but I may be slow to
respond while the rewrite settles.

## Concepts

| Concept | What it is |
|---|---|
| **City** | A project directory. Persistent across sessions, even when no worker is attached. |
| **Worker** | A tmux session running an agent (Claude Code, Codex, etc.), clustered around its city. |
| **Fiber** | An open concern attached to a city — a task, a decision, a question — managed by [felt](#related-projects). |
| **Playground** | An interactive HTML scratch surface per city, served from `.portolan/playgrounds/`. |
| **Vellum workspace** | The shared reader/editor for files and fibers, opened with `v` / `k` / `/`. |

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a richer picture. In short:

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer
├── CityManager               ├── Camera
├── OriginManager             ├── MapChromeBar
├── FiberReader               ├── Vellum workspace
├── GitStatusManager          ├── Find dashboard
├── RecentFileTracker         ├── WorkerPicker
├── Shuttle                   └── PlaygroundViewer
└── HttpApi
```

The server polls tmux, builds runtime state, and broadcasts it over WebSocket.
The browser renders cities and workers as a hex map; clicks route to Kitty,
which focuses the matching tab. File touches flow through a single hook
(`server/hooks/portolan-hook.sh`) into a JSONL event stream tailed by both the
local watcher and the remote `portolan-agent`.

React is contained inside `src/vellum/` and a few Radix-backed modal surfaces;
the map, renderer, chrome bar, and worker dialogs are vanilla TypeScript.

## Running

```bash
./dev.sh              # Start/attach the shared tmux session (frontend + backend + Shuttle)
./dev.sh restart      # Bounce it from any terminal
./dev.sh kill         # Stop and free ports 5173, 4004, 4000

npm run tauri:dev     # Native desktop shell around the same dev stack
npm run tauri:build   # Build Portolan.app + DMG
cd server && npm test # ~282 tests
```

Requirements: Kitty with `allow_remote_control yes` and
`listen_on unix:/tmp/kitty-socket`, tmux, Node 20+, and (for the Rust crates)
a recent stable Rust toolchain.

## Repo layout

- `src/` — browser code (Three.js renderer, vanilla TS, plus React in `src/vellum/`)
- `server/` — Node backend, HTTP/WebSocket API, tmux + felt integration
- `crates/` — Rust workspace (`portolan-agent`, `portolan-index`, `portolan-agent-protocol`)
- `src-tauri/` — Tauri desktop shell
- `scripts/` — install scripts for tunnels, hooks, the reminders bridge
- `tools/` — auxiliary tools (`reminders-bridge` syncs felt fibers to macOS Reminders)
- `share/` — installable templates (launchd plists, etc.)
- `reference/` — design playgrounds and visual studies (HTML + small images)
- `public/` — static assets (fonts, sprites, terrain)
- `.claude/skills/` — Claude Code skill definitions used while developing Portolan

## Related projects

Portolan sits inside a small constellation of tools, none of them yet packaged
for general use:

- **vellum-reader** — the shared reader/editor for markdown, fibers, and
  annotations. Required as a sibling source tree.
- **felt** — the fiber store. Fibers live as directory-contained markdown with
  a tiny YAML frontmatter; felt is the substrate, projects own any extra fields.
- **shuttle** — an Elixir kanban for dispatching agents to constitutions.

## License

[MIT](LICENSE).

## A note on the name

A *portolan chart* is a medieval navigation map — coastlines drawn with care,
windrose lines radiating from compass roses, the interior left mostly blank.
That's the design metaphor: chart the edges of the working environment, leave
the deep work to other tools.
