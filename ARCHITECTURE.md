# Portolan Architecture

> A spatial map for Claude sessions. Click to go there.

Portolan is a navigation layer for active work. The map answers three questions:

- Which projects are alive?
- Which workers are attached to them?
- Where should a click or hotkey route me next?

Deep work stays in terminal sessions and vellum. The map stays spatial.

## Core Loop

1. `SessionTracker` observes tmux sessions and working directories.
2. `CityManager` groups sessions into project cities.
3. `OriginManager` and `RemoteAgentCoordinator` fold in remote workers.
4. `BrowserStateCoordinator` broadcasts state over WebSocket.
5. The browser renders cities, workers, and the map chrome.
6. Clicking a worker asks `KittyIntegration` to focus that terminal tab.

## Current Shape

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer
├── CityManager               ├── Camera
├── OriginManager             ├── MapChromeBar
├── FiberReader               ├── Vellum workspace
├── GitStatusManager          ├── Find dashboard
├── RecentFileTracker         ├── WorkerPicker
├── RecentsStore              ├── NewWorkerDialog
├── Shuttle                   └── PlaygroundViewer
└── HttpApi
```

React is contained in `src/vellum/` plus Radix-backed modal surfaces. The map, renderer, chrome bar, context menu, and worker dialogs are vanilla TypeScript.

## Reading Surface

Files and fibers share the vellum workspace:

```
openVellumWorkspaceModal(...)
  → WorkspaceMount
  → FiberPage / FileViewerPage
  → PortolanAdapter
  → server HTTP endpoints
```

The old standalone file modal and CityHUD are retired. Per-city detail now lives in vellum's Find tab; the persistent map UI is `MapChromeBar`.

## Server Data

- Runtime state: tmux sessions, cities, workers, activity, remote origins.
- Felt state: fibers, fiber trees, global search, kanban transitions.
- File state: project file search, raw/content fetches, annotations, recent file touches.
- Research state: `/tapestry`, `/astra/graph`, evidence, and ASTRA view endpoints.
- Shuttle state: fiber dispatch, worker launch, review transitions.

## Design Constraints

- Keep terminal interaction in Kitty.
- Keep map interaction spatial and lightweight.
- Keep file/fiber reading in vellum.
- Prefer AppDialog for new modal surfaces.
- Keep remote and local workers flowing through the same activity sinks.
