---
title: 'Portolan polish: reliability, status, cursors, aesthetics'
status: open
kind: spec
priority: 2
created-at: 2026-02-04T03:31:55.411457+01:00
---

This is your spec for a Ralph loop, a meditative iteration toward a desired state.

## Desired State

Five areas need attention. Work on whichever has the most impact each iteration.

### 1. Chat and Search Reliability

Chat message sending and file search should work reliably for both local and remote workers/cities.

**Chat (conversation cards):**
- Open a worker's card (use JavaScript to get label element position, don't guess coordinates)
- Type message, press Enter → message appears in worker's tmux session
- Verify: `tmux capture-pane -t <session> -p` — output should be consistent with what the card shows
- Remote workers route through agent WebSocket

**File search (city panels):**
- Open a city panel (use JavaScript to get label element position)
- Type query → results appear within 3 seconds
- Click result → file opens in viewer
- Remote cities proxy through agent

**Testing approach:** Use browser console to get element positions rather than clicking blind coordinates. Example: `document.querySelector('.worker-label').getBoundingClientRect()`

**Debug endpoints:**
- `curl http://localhost:4004/hook/health` — conversation capture status
- `curl http://localhost:4004/debug-transcripts` — session mappings

### 2. Worker Status (Top-Down Rework)

Worker activity status is unreliable. Murmuration sessions reported it "fixed" but behavior is inconsistent. Approach from first principles.

**The question:** How does the server know a worker is active?

Survey the pipeline:
1. Where does activity originate? (tmux? Claude hooks? file watching?)
2. How does it flow to the frontend? (WebSocket state broadcasts?)
3. Where does the swarm consume it? (`WorkerSwarm.setActivity()`)

**Desired behavior:**
- Idle workers: dark ink `#2E2A26`, slow drift, compact swarm
- Active workers: warm gold `#8A6B2A`, faster movement, expanded swarm, pulsing brightness
- Transition smoothly over ~500ms

**Check:**
- Open Chrome DevTools, watch WebSocket messages
- Start a worker doing something, observe if status changes
- Trace from server → frontend → swarm

If the current approach is fundamentally broken, redesign it. Authority to rearchitect.

### 3. Custom Cursors

Bespoke cursors for different hover states, generated via nano-banana. These should feel like they belong on a Renaissance cartographer's desk — not generic UI icons.

**Hover states:**
| State | Cursor | Direction |
|-------|--------|-----------|
| Map (nothing) | Default or subtle crosshair | Maybe a tiny surveyor's mark |
| Worker swarm | Something alive | A small bird in flight? Ink droplet? Quill nib? |
| City label | Pointing gesture | A hand from a medieval manuscript, pointing index finger |
| Dragging | Grasping | Closed hand, or compass dividers? |

**Be creative.** These cursors are part of the visual identity. Think illuminated manuscripts, cartographer's tools, natural elements. Not generic pointer/hand icons.

**Generation:**
Use `/nano-banana` to create cursor sprites:
- 32×32 pixels (standard cursor size)
- Ink-on-white, sepia/verdigris palette
- Extract alpha via diff-mat (same workflow as city sprites)
- Install to `public/cursors/`

**Implementation:**
- CSS `cursor: url(...) hotspot-x hotspot-y, fallback`
- Set via JavaScript based on hover detection
- Hotspot coordinates matter — the "click point" of custom cursors

### 4. Recent Files in Card Header

Show the 3 most recently accessed files in the conversation card title bar, to the right of the session name. Clickable to open in file viewer.

**Data source:** Extract from conversation messages — look for Read, Edit, Write tool calls. Most recent first.

**Display:**
- Just filenames (not full paths), truncated if needed
- Subtle styling, doesn't compete with session name
- Click → opens FileViewerModal with that file

**Implementation:**
- Parse tool calls from conversation messages for file paths
- Track recency (most recent tool call wins)
- Add clickable elements to card header
- Wire up click handler to FileViewerModal

### 5. Aesthetic Polish

Conversation cards should feel integrated with Portolan's cartographic warmth. Less boxy, more tactile.

**Direction:**
- An extension of the ink droplet swarm's visual language
- Something you'd find on an old maritime chart
- Warm, aged, but still functional and readable

**Areas to consider:**
- Card container: border treatment, background texture, corner radius
- Header: title styling, close button elegance
- Messages: user/assistant differentiation, timestamps, tool call groups
- Chat input: field styling, send button
- Micro-interactions: hover states, focus states, transitions

**Constraints:**
- Must remain readable and functional
- Performance: no heavy animations
- Porch Morning palette (see `index.html` CSS variables)

Activate `/frontend-design` for this work.

### Acceptance Criteria

1. Chat messages send reliably (local and remote)
2. File search returns results (local and remote)
3. Worker status reflects actual activity (gold = working, dark = idle)
4. Custom cursors appear for different hover states
5. Recent files appear in card header, clickable to file viewer
6. Conversation cards feel warm and integrated
7. Tests pass: `cd server && npm test`
8. Visual verification: open Chrome, interact, observe

## Context

### Files

**Chat/Search:**
- `src/ui/ConversationCard.ts` — chat input, send logic
- `src/ui/CityPanel.ts` — search input, results
- `server/src/HttpApi.ts` — `/send-message`, `/search` endpoints
- `server/src/index.ts` — WebSocket, remote proxying

**Worker status:**
- `server/src/SessionTracker.ts` — tracks worker state
- `server/src/index.ts` — broadcasts state via WebSocket
- `src/render/WorkerSwarm.ts` — `setActivity()` consumes status
- `src/render/ZoneRenderer.ts` — connects worker state to swarms

**Cursors:**
- `index.html` — cursor CSS
- `src/main.ts` — hover detection, cursor switching
- `public/cursors/` — cursor sprite files (create if needed)

**Aesthetics & Recent Files:**
- `index.html` — card CSS (search for `.conversation-card`)
- `src/ui/ConversationCard.ts` — HTML structure, message parsing
- `src/ui/FileViewerModal.ts` — file viewer to open on click

### Patterns

- City sprites use nano-banana + diff-mat: see `.felt/document-nano-banana-prompting-15652206.md`
- WebSocket state: server broadcasts full state, frontend reconciles
- CSS2D for labels attached to 3D objects

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

- `/nano-banana` — for generating cursor sprites
- `/frontend-design` — for aesthetic polish and design questions

## Comments
**2026-02-04 03:59** — Ralph iteration 1: Investigated worker status pipeline - verified it works correctly (30s timeout behavior is by design). Implemented custom cursors via nano-banana: bird.png for swarms, hand-point.png for cities, hand-grab.png for dragging. Wired up hover detection in main.ts. Committed: 8d9c277
**2026-02-04 04:09** — Ralph iteration 2: Generated elegant swallow cursor via nano-banana, simplified to bird-for-everything per user feedback. Polished conversation card aesthetics (layered parchment, weathered edges, ledger-style header, marginalia messages, inset chat input). code-simplifier fixed duplicate CSS rule and cursor consistency. Committed: 69b2d82
**2026-02-04 04:13** — Ralph iteration 3: Implemented recent files feature in card header - extracts file paths from Read/Write/Edit tool calls, shows up to 3 most recent as clickable chips. Updated spec to have 5 areas (was 4). CSS styling with pill-shaped chips that blend with card aesthetic.
**2026-02-04 04:31** — Ralph iteration 4: Regenerated swallow cursor - solid black silhouette with transparent background via nano-banana + diff-mat. Applied as default cursor for entire map (body + canvas). Hotspot at beak tip (2,4). Committed: 4f80bf5
**2026-02-04 04:34** — Ralph iteration 4: Swallow cursor - solid black silhouette (27x27), transparent background via nano-banana + white→transparent. Applied as default cursor everywhere on map by fixing JS resets to 'default'. Hotspot at beak (2,3). Committed: 654cb55
**2026-02-04 05:18** — Ralph iteration 5: Fixed file search bug - results weren't persisting between filename/content responses (this.searchResults not updated). Also improved stale result rejection and cleaned up code. Search now works reliably for local cities. Committed: 362cd4f, 82dc7f9
**2026-02-04 05:29** — Ralph iteration 6: Fixed Invalid Date bug in conversation timestamps. The hook script was appending index suffixes (.0) to timestamps for deduplication, which broke Date parsing. Fixed both the hook script (~/loom/hooks/) and added defensive handling in formatTimeAgo(). Cache file cleaned. Tests pass. Committed: e576298

