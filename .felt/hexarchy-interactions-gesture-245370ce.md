---
title: 'Hexarchy Interactions: gesture map and UI panels'
status: closed
kind: spec
priority: 2
depends-on:
    - hexarchy-overview-spatial-map-40356835
created-at: 2026-01-30T17:41:37.42436+01:00
closed-at: 2026-01-30T17:41:37.424362+01:00
close-reason: |-
    ## Gesture Map

    | Gesture | Target | Action |
    |---------|--------|--------|
    | **Click** | Worker | Select (gold outline) |
    | **Click** | City | Select, open CityPanel |
    | **Click** | Empty | Deselect |
    | **Double-click** | Worker | Focus Kitty terminal tab |
    | **Double-click** | City | Open new worker dialog |
    | **Double-click** | Empty (near city) | Open new worker dialog for nearest city |
    | **Right-click** | Worker | Context menu (Focus Tab, Retire Worker) |
    | **Right-click** | City | Context menu (New Worker, Move City, Remove) |
    | **Force Touch** (Mac) | Any | Same as right-click |
    | **Drag** | Canvas | Sieve pan (point stays under cursor) |
    | **Scroll** | Canvas | Zoom in/out |
    | **Arrow keys** | — | Pan camera |

    ## UI Panels

    **CityPanel** — Opens on city click. Shows:
    - City name, fiber count badge
    - Tabbed view: Files / Fibers
    - Search bar filters both tabs
    - Recently edited files with click-to-view
    - Annotated files section

    **WorkerActivityPanel** — Opens from CityPanel worker list. Shows:
    - Worker name, status
    - Activity history (file reads, edits, commands)
    - Click file → FileViewerModal

    **FileViewerModal** — Full-screen file viewer:
    - Code with syntax highlighting (CodeMirror)
    - Image preview with click-to-annotate
    - Arrow keys navigate file list
    - Annotation panel for feedback to workers

    **ContextMenu** — Right-click or Force Touch:
    - Worker: Focus Tab, Retire Worker
    - City: New Worker, Move City, Remove City

    ## Key Files
    - `src/main.ts` — event handlers (click, dblclick, contextmenu, force touch)
    - `src/ui/CityPanel.ts`
    - `src/ui/WorkerActivityPanel.ts`
    - `src/ui/FileViewerModal.ts`
    - `src/ui/ContextMenu.ts`
---
