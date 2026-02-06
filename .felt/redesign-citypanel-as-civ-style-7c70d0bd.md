---
title: Redesign CityPanel as Civ-style corner HUD
status: active
kind: spec
priority: 2
created-at: 2026-02-06T23:28:24.351499+01:00
---

## Vision

Replace the right-side sliding panel with corner-anchored HUD widgets overlaying the map. The Civ trick: information lives in the corners and edges, center stays clear for the map.

Porch Morning aesthetic. Opaque parchment surfaces with subtle shadow. Only the exposed inner corner (facing map center) is rounded.

## Layout

```
┌─────────────────────────────────────────┐
│ [Identity]              [Git Detail]    │
│  portolan                branch: ...    │
│  ~/proj/portolan         staged: ...    │
│  coastline-exp ●3 +84                   │
│                                         │
│               (map clear)               │
│                                         │
│ [Workers]                 [Fibers]      │
│  ● coastline-exp           ○ Vellum... │
│  ○ fiber-review            ○ Nano-...  │
│  ● test-runner             ◐ Coast... │
│                          ┌──────────┐   │
│                          │ Search…  │   │
│                          └──────────┘   │
└─────────────────────────────────────────┘
```

Search bar sits below fibers, expands over them on focus. Actions (+ Worker) integrated into identity or as icon buttons. Claims/Playgrounds buttons appear conditionally — only when a city has them — as subtle icons near identity.

## Design Principles

- **Additive then subtractive.** Build all widgets, then merge/cut what's too busy.
- **Each widget is self-contained.** Own DOM, own chrome, own positioning.
- **Replace, don't coexist.** Build CityHUD.ts, swap it into main.ts immediately. CityPanel.ts stays in the repo for reference but is dead code from Loop 1 onward.
- **Parchment chrome.** Each widget: `background: linear-gradient(...)`, `box-shadow`, inner-corner radius only.
- **Show/hide is per-city.** HUD appears when a city is selected, disappears on click-away/Escape.

## Ralph Loop — One Feature Per Iteration

Each loop: implement one widget, wire it up, verify it renders. Human steers between loops.

### Loop 1: Scaffold CityHUD.ts + Identity Widget
- Create `src/ui/CityHUD.ts` with corner container structure
- Top-left: city name (small-caps, EB Garamond), path, inline git summary
- Parchment chrome with inner-corner rounding
- Wire into `main.ts` alongside existing panel (toggled by a flag or always-on)
- show(city)/hide() API matching CityPanel interface

### Loop 2: Fiber List Widget (bottom-right)
- Bottom-right corner widget showing open fibers
- Status icon, title, kind badge
- Click opens `.felt/{id}.md` in FileViewerModal
- Handoff button (↗) wired to WebSocket
- Max ~4 fibers visible, scrolls if more

### Loop 3: Search Bar (below fibers)
- Compact search input below fiber list
- On focus: expands upward over fiber list
- On Enter: triggers unified search (filename + content + fiber filter)
- Results overlay the fiber widget area
- Clear button, Escape to collapse

### Loop 4: Worker Status Widget (bottom-left)
- Bottom-left corner showing active workers for this city
- Dot (teal=working, grey=idle) + name + last activity
- Click → focus that worker's terminal (Kitty integration)

### Loop 5: Git Detail Widget (top-right)
- Detailed git: branch, staged/unstaged counts, diff stats, last commit
- Only shown when city has git status
- Compact monospace layout

### Loop 6: Conditional Actions (Claims, Playgrounds, + Worker)
- + Worker button near identity or as floating action
- Claims/Playgrounds icons appear only when city.hasClaims/hasPlaygrounds
- NewWorkerDialog wiring

### Loop 7: Polish — Transitions, Escape/Click-Away, Cleanup
- Fade-in/out animations
- Escape dismisses HUD
- Click-away handling (reuse CityPanel pattern)
- Remove or gate old CityPanel code
- Responsive: widgets reflow on narrow viewports

## Files Touched

- `src/ui/CityHUD.ts` — NEW, main implementation
- `src/main.ts` — swap CityPanel → CityHUD
- `index.html` — HUD CSS (or inline in CityHUD)
- `src/ui/CityPanel.ts` — untouched until Loop 7

## Playground

Interactive explorer: `.portolan/playgrounds/city-hud-explorer.html`

## Comments
**2026-02-06 23:51** — Loop 2 complete: Fiber List Widget. Bottom-right corner parchment widget showing open+closed fibers (max 6, overflow indicator). Status icons (○/◐/●), kind badges (spec/decision/question/doc with color accents), click-to-view in FileViewerModal, handoff button (↗). Staggered animation (140ms delay after identity). Shared fiberStatusIcon() extracted to utils.ts. Types imported from CityPanel (type-only, no runtime dep).

