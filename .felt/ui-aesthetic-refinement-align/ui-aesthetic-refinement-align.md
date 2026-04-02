---
title: 'UI aesthetic refinement: align with Porch Morning'
status: closed
created-at: 2026-01-18T14:30:43.959101+01:00
closed-at: 2026-01-18T15:58:27.581911+01:00
---

(ui-aesthetic-refinement-align)=
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

Align hexarchy-v2's visual aesthetic with the Porch Morning palette — typography, colors, textures, panel styling — creating visual coherence with the conducting-research dashboard.

## Design

### Typography

**Fonts to load** (Google Fonts):
- EB Garamond: body text, display (with small-caps for headers)
- JetBrains Mono: code, monospace elements

**Replace in `index.html`:**
```html
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

**CSS variables:**
```css
--font-main: 'EB Garamond', Garamond, serif;
--font-mono: 'JetBrains Mono', monospace;
```

**Header styling:**
```css
h1, h2, h3 {
  font-variant: small-caps;
  text-transform: lowercase;
  letter-spacing: 0.06em;
  font-weight: 500;
}
```

### Color Palette

Replace current Cartographic Warmth with Porch Morning:

```typescript
// In types.ts — replace PALETTE and PALETTE_CSS

export const PALETTE = {
  // Backgrounds
  bgPrimary: 0xc8b8a8,     // Main background, ground plane
  bgCard: 0xede8e0,        // Panels
  bgElevated: 0xfdfcfa,    // Elevated elements

  // Text
  textPrimary: 0x2e2a26,
  textSecondary: 0x4a4540,
  textMuted: 0x7a7368,

  // Borders
  border: 0xa89888,
  borderLight: 0xc8bba8,

  // Semantic
  accent: 0x5a7b7b,        // Teal — working state
  gold: 0x9a7b35,          // City hexes
  goldLight: 0xc4a86a,     // City highlights
  green: 0x6b8b6b,         // Success states
  red: 0xa87070,           // Attention state

  // Hex-specific
  cityHex: 0x9a7b35,       // Gold — cities
  workerIdle: 0x7a7368,    // Muted — dormant workers
  workerActive: 0x5a7b7b,  // Teal — working
  workerAttention: 0xa87070, // Red — needs attention
  emptyHex: 0xc8b8a8,      // Background terrain
  selection: 0xc4a86a,     // Gold highlight ring
} as const

export const PALETTE_CSS = {
  bgPrimary: '#C8B8A8',
  bgCard: '#EDE8E0',
  bgElevated: '#FDFCFA',
  textPrimary: '#2E2A26',
  textSecondary: '#4A4540',
  textMuted: '#7A7368',
  border: '#A89888',
  borderLight: '#C8BBA8',
  accent: '#5A7B7B',
  gold: '#9A7B35',
  goldLight: '#C4A86A',
  green: '#6B8B6B',
  red: '#A87070',
} as const
```

### Panel Styling (CityPanel + index.html)

**Background treatment:**
```css
#city-panel {
  background: #EDE8E0;
  border-left: 1px solid #A89888;
  background-image:
    linear-gradient(rgba(168, 152, 136, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(168, 152, 136, 0.03) 1px, transparent 1px);
  background-size: 20px 20px;
  box-shadow: -2px 0 8px rgba(46, 42, 38, 0.12);
}
```

**City name styling:**
```css
#city-panel .city-name {
  font-family: var(--font-main);
  font-variant: small-caps;
  text-transform: lowercase;
  letter-spacing: 0.06em;
  font-size: 1.5rem;
  color: #2E2A26;
}
```

**Section headers:**
```css
#city-panel .fibers h3 {
  font-variant: small-caps;
  text-transform: lowercase;
  letter-spacing: 0.1em;
  font-weight: 600;
  color: #4A4540;
  border-bottom: 1px solid #C8BBA8;
}
```

**Fiber items:**
```css
#city-panel .fiber-item {
  border-bottom: 1px solid rgba(200, 187, 168, 0.5);
}

#city-panel .fiber-kind {
  background: rgba(90, 123, 123, 0.15);
  color: #5A7B7B;
}
```

### 3D Rendering (ZoneRenderer)

**Ground plane:** Use `PALETTE.bgPrimary` instead of sand

**Empty hexes:** Use `PALETTE.emptyHex` — slightly elevated terrain feel

**City hexes:** Use `PALETTE.cityHex` (gold) with `PALETTE.border` for edge

**Worker hexes by status:**
- idle → `PALETTE.workerIdle`
- working → `PALETTE.workerActive` (teal)
- attention → `PALETTE.workerAttention` (red)

**Labels:** Update `createLabel()` to use EB Garamond:
```typescript
ctx.font = `500 ${fontSize}px 'EB Garamond', serif`
```

**Selection ring:** Use `PALETTE.selection` (gold light)

### Body Background

In `index.html`:
```css
body {
  background: #C8B8A8;
  font-family: 'EB Garamond', Garamond, serif;
}
```

## Context

@/Users/cd280747/.claude/skills/conducting-research/templates/dashboard/dashboard.css — Porch Morning palette source
@/Users/cd280747/Documents/projects/hexarchy-v2/index.html — fonts, body styles, panel CSS
@/Users/cd280747/Documents/projects/hexarchy-v2/src/state/types.ts — PALETTE definitions
@/Users/cd280747/Documents/projects/hexarchy-v2/src/render/ZoneRenderer.ts — 3D hex colors, label generation
@/Users/cd280747/Documents/projects/hexarchy-v2/src/ui/CityPanel.ts — panel component (DOM structure)

## Completion

**Verify by doing, not by checking boxes:**
- Run `./dev.sh` and open browser
- Visual check: background is warmer (#C8B8A8), not the cooler sand
- Visual check: typography is EB Garamond with small-caps headers
- Visual check: city hexes are gold, workers show status colors (idle=muted, working=teal)
- Open a city panel: styling matches Porch Morning (grid texture, shadows, font styling)
- Fiber items render correctly with new colors
- No visual regressions — labels readable, hexes distinct, panel functional
