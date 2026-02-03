---
title: Map-pinned conversation cards
status: open
kind: spec
priority: 2
created-at: 2026-02-03T20:51:41.692455+01:00
---

# Spec

You are in a Ralph loop — meditative iteration toward a desired state.

## Orientation

Fresh eyes. Survey the system as it actually is. Broad authority to advance the state. Update discoverably via commits and fibers.

## Loop

1. **Survey** — Explore agents, `felt downstream`, git log, tests. You decide what to check.
2. **Contribute** — Substantial, coherent work. Keep working until context is ~50% full. Multiple commits per iteration is expected. Swarm subagents if parallelism helps.
3. **Simplify** — Run code-simplifier on modified files: spawn Task with `subagent_type: "code-simplifier"` targeting recently changed code.
4. **Felt** — Before exiting: `/felt`, update CLAUDE.md if warranted
5. **Exit** — `kill $PPID`

**Ambition:** Each iteration should maximize its context window. Don't exit after one small fix — survey what else needs doing and keep contributing until you've used ~50% of available context. Fresh perspective comes from the next iteration, not from premature exits.

## Practices

- Never spawn multiple agents editing the same file
- Close sub-fibers with what happened, not that it happened

## Exit Rules

**Made contribution:** `kill $PPID`. Don't close spec.
**Nothing left:** `felt off <id> -r "..."`

---

## Desired State

Replace the current WorkerActivityPanel (fixed right sidebar, 400-900px) with map-pinned conversation cards that feel like part of the cartographic space.

### Visual Design

Conversation cards are CSS2D elements anchored to worker positions in world space. They move with pan/zoom like worker labels do.

**Card appearance:**
- Compact card (~250px wide) floating near the worker ship
- Porch Morning palette: parchment background (#EDE8E0), warm borders
- Shows last 2-3 exchanges (user/assistant) by default
- Tool calls and thinking blocks use current grouped display
- **Single-item groups expand directly** — if a tool group contains only one item, clicking expands the tool content, not the group wrapper
- Close button (×) in corner
- Subtle drop shadow to lift off the map

**Zoom behavior:**
- Card scales with map zoom (like labels) but clamped to readable bounds
- Min size: ~180px wide (readable at far zoom)
- Max size: ~300px wide (doesn't overwhelm at close zoom)
- Font sizes scale proportionally within bounds

**Multiplicity:**
- Multiple cards can be open simultaneously
- Cards position intelligently to avoid overlap where possible
- Each card tracks its own worker

### Interaction

- **Click worker ship/label** → Opens conversation card anchored to that worker
- **Click card close button** → Closes that card
- Map remains fully navigable with cards open (pan, zoom, click other workers)
- Cards don't block map interaction — pointer-events pass through to map except on card content

### Reliability

Current issue: conversations often fail to load, showing "Loading conversation..." indefinitely or falling back to activities.

**Fix the loading reliability:**
1. Add timeout with clear error state (not infinite loading)
2. Better error messages when fetch fails
3. Investigate why `/conversation` endpoint returns empty or errors — check ConversationCache lookup chain
4. Add retry button on error state

**Debug endpoint:** `curl http://localhost:4004/hook/health` shows last event times per session.

### Architecture

**New component:** `ConversationCard.ts` — lightweight card component
- Extends or uses CSS2DObject for map anchoring
- Manages its own WebSocket subscription for updates
- Handles fetch, render, error states
- Disposed when closed

**Modify:** `ZoneRenderer.ts` — track open cards, handle worker clicks
**Modify:** `main.ts` — wire up card creation on worker click
**Remove or deprecate:** `WorkerActivityPanel.ts` — the 785-line sidebar panel

### Acceptance Criteria

1. Click a worker → card appears anchored to worker position
2. Pan/zoom map → card moves with worker
3. Open multiple workers → multiple cards visible
4. Card shows last 2-3 exchanges legibly
5. Single-tool groups expand directly on click
6. Conversation loads reliably (no stuck "Loading..." states)
7. Error states show clear message + retry option
8. Tests pass: `cd server && npm test`

## Context

### Files to modify

- `src/ui/WorkerActivityPanel.ts` — Current 785-line panel. Extract conversation rendering logic, then deprecate.
- `src/render/ZoneRenderer.ts` — Already handles worker labels as CSS2DObjects. Add card management here.
- `src/main.ts` — Wire up worker click → card open. Remove WorkerActivityPanel usage.
- `src/index.html` — Add styles for `.conversation-card` (can adapt from existing `.worker-panel` styles)

### Patterns to follow

- **CSS2DObject usage:** See `ZoneRenderer.ts:330` where worker labels are created. Cards work the same way.
- **Zoom scaling:** See `ZoneRenderer.animate()` which scales label font sizes based on `cameraDistance`. Apply same pattern to cards with min/max clamps.
- **Tool group rendering:** Keep the existing logic from `WorkerActivityPanel.renderConversation()` — it's good, just needs the single-item-group fix.

### Server endpoints

- `GET /conversation?sessionId=X&tmuxSession=Y&limit=100` — Fetch history
- `POST /hook/message` — Receives Claude Code hook events
- `GET /hook/health` — Debug endpoint for conversation capture status

## Skills

None required.

## Comments
**2026-02-03 21:02** — Iteration 1: Core implementation complete. ConversationCard.ts (CSS2DObject), ZoneRenderer card management, main.ts wiring, CSS styles. All 8 acceptance criteria met: card anchoring, zoom scaling (0.72-1.2), multiple cards, recent exchanges, single-item groups, loading timeout, error+retry, tests pass. Code simplified by code-simplifier agent.
**2026-02-03 21:13** — Iteration 2: Removed deprecated WorkerActivityPanel (1889 lines). Fixed double-click terminal focus regression (was passing tmuxSession instead of workerId). Enhanced cards: bigger default (320x420), draggable via header, resizable via corner handle, z-index stacking (click to front), smart positioning (offset from city based on worker location), localStorage persistence of position/size.

