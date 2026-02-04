---
title: Conversation card aesthetic polish
status: open
kind: spec
priority: 2
depends-on:
    - murmuration-workers-68674cb9
created-at: 2026-02-04T01:32:54.027446+01:00
---

# Spec

You are in a Ralph loop — meditative iteration toward a desired state.

## Orientation

Fresh eyes. Survey the system as it actually is. Broad authority to advance the state. Update discoverably via commits and fibers.

## Loop

1. **Survey** — Open `http://localhost:5173` in Chrome. Look at the conversation cards. Feel the aesthetic.
2. **Design** — Activate `/frontend-design`. Propose or iterate on visual improvements.
3. **Implement** — Make CSS/HTML changes. Small, focused commits.
4. **Visual check** — Refresh Chrome. Does it feel better? Take screenshots to compare before/after.
5. **Iterate** — Keep refining until the card feels integrated with the Portolan aesthetic.
6. **Felt** — Before exiting: `/felt`, update CLAUDE.md if warranted
7. **Exit** — `kill $PPID`

**This is design work.** Trust your visual judgment. The goal is a card that feels like it belongs — warm, tactile, cartographic.

## Practices

- Never spawn multiple agents editing the same file
- Close sub-fibers with what happened, not that it happened

## Exit Rules

**Made contribution:** `kill $PPID`. Don't close spec.
**Nothing left:** `felt off <id> -r "..."`

---

## Desired State

Conversation cards feel integrated with Portolan's cartographic warmth. Less boxy, more tactile, with satisfying micro-interactions.

### Current Issues

- **Too boxy/rigid** — needs softer edges, more organic feel
- **Lacks micro-interactions** — hover states and transitions feel flat
- **Text aesthetics** — EB Garamond is good, but other text styling needs care

### Direction

Let `/frontend-design` explore. The card should feel like:
- An extension of the ink droplet swarm's visual language
- Something you'd find on an old maritime chart
- Warm, aged, but still functional and readable

### Specific Areas

**Card container:**
- Border treatment (softer? textured? shadow?)
- Background (subtle texture? paper-like?)
- Corner radius (organic curves?)

**Header:**
- Title styling (small-caps is good, what else?)
- Close button (more elegant?)

**Messages:**
- User/assistant message styling
- Timestamps
- Tool call groups

**Chat input:**
- Input field styling
- Send button

**Micro-interactions:**
- Hover states on messages, tools, buttons
- Expand/collapse animations
- Focus states

### Constraints

- Must remain readable and functional
- Performance: no heavy animations
- Porch Morning palette: see `index.html` CSS variables

## Context

### Files to modify

- `index.html` — All card CSS is here (search for `.conversation-card`)
- `src/ui/ConversationCard.ts` — HTML structure if changes needed

### Palette reference

```css
--parchment-bg: #C8B8A8
--parchment-light: #EDE8E0
--parchment-edge: #BBA890
--ink-dark: #2E2A26
--ink-body: #3D3835
--ink-light: #5A534E
--ink-faded: #7A7368
--sepia-accent: #8A6B2A
--verdigris: #4A6258
--rust: #8A5548
```

## Skills

**Required:** `/frontend-design` — Activate this skill for design exploration and iteration.
