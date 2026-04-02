---
title: 'Global Views: Map/Plots/Plans switching + Claims Dashboard'
status: closed
created-at: 2026-01-19T03:22:42.120701+01:00
closed-at: 2026-01-19T09:08:22.958021+01:00
---

(global-views-map-plots-plans)=
# Ralph Spec

You are in a Ralph loop — autonomous iteration toward completion.

---

## Your Rhythm

1. **Survey** — Read previous work for orientation (`felt downstream <fiber-id>`).
   Use it for context — files touched, concepts named — but apply fresh judgment.
   Scan the spec and codebase. What's incomplete? What needs verification? What could improve?

2. **Prioritize** — Identify the single highest-value task to work on yourself.
   This is what you'll focus on in this session.

3. **Delegate** — Any routine, isolated tasks can be launched as background agents (2-3 max, different files).
   For each: create child fiber, launch with Task tool (run_in_background: true).
   Do NOT check their progress or output. They will notify you when finished.

4. **Work** — Focus on your high-value task. If agents finish while you're working, briefly note their results and continue.
   If you have nothing to work on yourself, just wait for agents to complete.

5. **Exit** — End every iteration with `kill $PPID`. The loop continues.

   **NEVER close the fiber if you made changes this iteration.**
   Made an edit? Fixed a bug? Added a test? → `kill $PPID`. That's it. Don't close.

   **Only close when you've actively checked everything and found nothing:**
   - You surveyed the full design and verified each part is implemented
   - You ran tests and they pass
   - You tried interacting with what was built and it works
   - You looked for edge cases, documentation gaps, code smells — nothing found
   - You made zero changes this iteration

   If ALL of that is true → `felt off <fiber-id> -r "summary"` then `kill $PPID`.
   If ANY of it is false → just `kill $PPID`. The loop continues.

---

## Key Principles

- **Form your own understanding of completion.** Don't mechanically check boxes. Read the design, understand the intent, verify that the implementation matches.
- **Fresh eyes each iteration.** Previous work informs but doesn't bind. Apply fresh judgment.
- **Light parallelism.** Chunk when it helps, but don't force it. Sequential is fine.
- **Don't poll agents.** They notify you. Compulsive checking burns context.

---

## Goal

Add Civilization-style global view switching to hexarchy: glass buttons for Map/Plots/Plans, iframe-based view overlays, and a claims dashboard accessible from city panels.

## Design

**Builds on Fireside Command** — The dark UI palette and CityPanel styling are already implemented. This spec adds global view switching and claims dashboard using the same aesthetic.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  [○ Map]  [○ Plots]  [○ Plans]               ← ViewSwitcher.ts │
├─────────────────────────────────────────────────────────────────┤
│                                            ┌──────────────────┐ │
│   ┌──────────────────────────────────┐     │   CityPanel      │ │
│   │                                  │     │                  │ │
│   │  ViewOverlay.ts (conditional)    │     │  [View Claims]*  │ │
│   │  - Map: hidden (canvas shows)    │     │                  │ │
│   │  - Plots: iframe :8873           │     │  ○ Fibers...     │ │
│   │  - Plans: iframe :19473          │     │                  │ │
│   └──────────────────────────────────┘     └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
* Only shown when city has claims

Claims Dashboard (when View Claims clicked):
┌─────────────────────────────────────────────────────────────────┐
│  [×]                                       ┌──────────────────┐ │
│  ┌──────────────────────────────────────┐  │   CityPanel      │ │
│  │                                      │  │   (stays open)   │ │
│  │  ClaimsDashboard.ts                  │  │                  │ │
│  │  iframe: claims_server for city      │  │                  │ │
│  │                                      │  │                  │ │
│  └──────────────────────────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Files to Create

**1. `src/ui/ViewSwitcher.ts`** — Glass circular buttons for global view switching.

```typescript
type GlobalView = 'map' | 'plots' | 'plans'

export class ViewSwitcher {
  private buttons: Map<GlobalView, HTMLElement>
  private currentView: GlobalView = 'map'
  private onViewChange: (view: GlobalView) => void

  constructor(onViewChange: (view: GlobalView) => void)
  private createButtons(): HTMLElement
  setActive(view: GlobalView): void
}
```

**2. `src/ui/ViewOverlay.ts`** — Fullscreen overlay for Plots and Plans views (iframe-based).

```typescript
export class ViewOverlay {
  private overlay: HTMLElement
  private iframe: HTMLIFrameElement

  constructor()
  show(url: string): void  // Sets iframe src, shows overlay
  hide(): void
}
```

Styling: Dark frame around iframe (`--ui-dark` border), fade-in animation.

**3. `src/ui/ClaimsDashboard.ts`** — Large panel for viewing claims DAG, leaves sidebar visible.

```typescript
export class ClaimsDashboard {
  private panel: HTMLElement
  private iframe: HTMLIFrameElement
  private closeBtn: HTMLElement

  constructor()
  show(cityId: string, dashboardUrl: string): void
  hide(): void
}
```

### Files to Modify

**`src/main.ts`**
- Add view state: `let currentView: GlobalView = 'map'`
- Instantiate ViewSwitcher, ViewOverlay, ClaimsDashboard
- Wire up view switching logic
- Handle canvas visibility based on view

**`src/ui/CityPanel.ts`**
- Add "View Claims" button (conditional)
- Add `hasClaims: boolean` to city data
- Emit event/callback when button clicked

**`src/state/types.ts`**
- Add `hasClaims?: boolean` to City interface

**`server/src/CityManager.ts`**
- Add `hasClaims` detection: check for `workflow/config/` or `results/claims/`
- Include in city data sent to frontend

**`index.html`**
- Add CSS for ViewSwitcher (glass buttons)
- Add CSS for ViewOverlay
- Add CSS for ClaimsDashboard

### CSS Design: Glass Buttons (Fireside Command aesthetic)

Uses dark UI palette from Fireside Command (already in index.html):
- `--ui-dark: #1A1816` (panel background)
- `--ui-gold: #C9A227` (gold accents)
- `--ui-gold-muted: #8B7355` (muted gold)
- `--ui-text: #E8E4DF` (light text)

```css
.view-switcher {
  position: fixed;
  top: 20px;
  right: 20px;
  display: flex;
  gap: 12px;
  z-index: 100;
}

.view-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--ui-dark);
  border: 1px solid var(--ui-gold-muted);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  transition: all 200ms ease;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text);
}

.view-btn.active {
  background: var(--ui-dark-elevated);
  border-color: var(--ui-gold);
  color: var(--ui-gold);
}

.view-btn:hover {
  transform: scale(1.08);
  border-color: var(--ui-gold);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
}
```

### SVG Icons (antiquarian style, inline in ViewSwitcher.ts)

```typescript
const icons = {
  map: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5">
    <polygon points="12,2 22,8 22,16 12,22 2,16 2,8"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`,

  plots: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5">
    <polyline points="4,18 4,6"/>
    <polyline points="4,18 20,18"/>
    <polyline points="6,14 10,10 14,12 18,6"/>
  </svg>`,

  plans: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5">
    <path d="M6,3 C4,3 4,5 4,5 L4,19 C4,21 6,21 6,21 L18,21 C20,21 20,19 20,19 L20,5 C20,3 18,3 18,3"/>
    <line x1="8" y1="9" x2="16" y2="9"/>
    <line x1="8" y1="13" x2="14" y2="13"/>
  </svg>`
}
```

### Server Changes

**Port Pattern (for remotes):**
Ports use `base + (hostname | cksum) % 100` for per-machine uniqueness:
- Plot server: `8800 + hash` (configured in `~/loom/shell-functions.sh`)
- Plannotator: `19400 + hash`
- Hexarchy uses whatever port Vite assigns (typically 5173)

For remote access, forward ports via SSH LocalForward.

**Claims Dashboard — Static Generation:**
Instead of spawning FastAPI server per-city, generate static HTML:

When "View Claims" is clicked:
1. Run: `python generate_claims_dashboard.py --claims-dir {cwd}/results/claims --specs-dir {cwd}/workflow/config --output /tmp/hexarchy-claims/{city-id}.html`
2. Point iframe to `file:///tmp/hexarchy-claims/{city-id}.html` or serve via Vite

This avoids spawning servers and simplifies port management. The dashboard regenerates on each click (fast, picks up new evidence).

**Claims Detection:**
```typescript
// CityManager.ts
private async detectClaims(cwd: string): Promise<boolean> {
  const hasSpecs = await exists(path.join(cwd, 'workflow/config'))
  const hasResults = await exists(path.join(cwd, 'results/claims'))
  return hasSpecs || hasResults
}
```

### Implementation Order

1. ViewSwitcher + ViewOverlay — Get global view switching working
2. Wire up Plots view — iframe to localhost:$PLOT_PORT (env var)
3. Wire up Plans view — iframe to localhost:$PLANNOTATOR_PORT (env var)
4. Server: hasClaims detection — Check city directories
5. CityPanel: View Claims button — Conditional display
6. ClaimsDashboard — Large overlay panel
7. Claims static generation — Run generate_claims_dashboard.py, serve HTML

## Context

src/main.ts — Bootstrap, state, event wiring; add view state here
src/ui/CityPanel.ts — Reference pattern for DOM overlays; add View Claims button
src/ui/ContextMenu.ts — Simpler reference for positioned UI
src/state/types.ts — Add hasClaims to City interface
server/src/CityManager.ts — Add claims detection
index.html — All CSS styles live here (dark UI vars already defined)

~/loom/skills/conducting-research/templates/scripts/generate_claims_dashboard.py — Static dashboard generator

### Already Done (from Fireside Command)

- Dark UI palette (`--ui-dark`, `--ui-gold`, etc.) ✓
- CityPanel with dark theme styling ✓
- WorkerPanel and NotificationStack removed ✓
- Top-right area available for ViewSwitcher ✓

## Testing

**Claims Dashboard Test Location:**
A pre-built static claims dashboard exists at:
```
candide:/automnt/n17data/cdaley/unions/pure_eb/results/claims/dashboard.html
```

To test:
1. SSH tunnel or mount the path locally
2. Or serve via local HTTP server:
   ```bash
   ssh candide 'python -m http.server 8765 -d /automnt/n17data/cdaley/unions/pure_eb/results/claims'
   # Then access via http://localhost:8765/dashboard.html (with port forwarding)
   ```

For local testing, update `main.ts` dashboardUrl to point to served location.

## Completion

**Verify by doing, not by checking boxes:**
- Run the tests. Do they pass?
- Try interacting with what you built. Does it work as intended?
- Look for edge cases not covered by tests. Handle them.
- Check that behavior is documented where appropriate.
- Read through the changes with fresh eyes. Anything feel off?

**Finished state:**
1. Glass buttons appear top-right: Map | Plots | Plans
2. Clicking Plots shows iframe to plot-server gallery (port from env)
3. Clicking Plans shows iframe to plannotator (port from env)
4. Clicking Map returns to hex grid
5. Cities with claims show "View Claims" button in panel
6. Clicking View Claims opens large overlay with claims dashboard (sidebar stays visible)
7. Dashboard shows claims DAG via static HTML (generated on demand)
