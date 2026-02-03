---
title: 'Ralph loop: autonomous portolan visual iteration'
status: closed
kind: spec
priority: 2
created-at: 2026-01-31T18:26:33.353367+01:00
closed-at: 2026-02-03T00:19:35.211123+01:00
close-reason: '26 iterations of autonomous visual refinement. Established: vellum shader, coastline rendering, rhumb lines, city sprites, worker ships. Design evolved from pure coastline-first toward hybrid with hex positioning. Ralph pattern validated for visual iteration work.'
---

# Spec

You are in a Ralph loop — meditative iteration toward a desired state.

## Orientation

You have fresh eyes. No context from previous iterations binds you — use that freedom. Survey the system as it actually is, not as someone described it.

You have broad authority to advance the state. The desired state below defines "done." Everything else is yours to decide: what to check, what to prioritize, how to contribute. Trust your judgment.

Update state discoverably. Commits, fibers, test results — not notes. The next iteration will find what changed by inspecting the system.

## Loop

Each iteration:

1. **Orient (brief)** — Read one reference portolan image at random. Let it inform your eye for this iteration.
   ```bash
   REF=$(ls reference/portolan-charts/*.jpg | awk 'BEGIN{srand()}{a[NR]=$0}END{print a[int(rand()*NR)+1]}')
   ```
   Then check `felt downstream ralph-loop-autonomous-portolan-84bd75bf` for recent iteration fibers — continue from where they left off.

2. **Survey (quick)** — Open `http://localhost:5173` in Chrome. Quick visual check — what's working, what's missing? Don't over-analyze.

3. **Contribute (substantial)** — **Complete a full feature or migration phase**, not a small tweak. Aim for 80% of iteration time here. Examples of good scope:
   - "Implement CoastlineRenderer.ts end-to-end"
   - "Complete Phase 2: coastline through cities"
   - "Add worker force simulation with all forces working"

   Start a sub-fiber (`felt add "..." -a ralph-loop-autonomous-portolan-84bd75bf`), but spend your time implementing, not documenting.

4. **Felt** — Extract any patterns or decisions as fibers. Update iteration log or CLAUDE.md if warranted.

5. **Exit** — Always `kill $PPID`.

## Practices

- **80/20 rule** — Spend 80% of iteration time implementing, 20% orienting/surveying. Bias toward action.
- **Complete features, not fragments** — A half-working renderer helps no one. Finish what you start.
- Never spawn multiple agents editing the same file — partition by file, not feature
- Close your iteration's sub-fiber with what happened, not just that it happened

## Exit Rules

**Made ANY contribution:** `kill $PPID`. Do NOT close the spec fiber. The next iteration verifies with fresh eyes.

**Made ZERO contributions AND nothing left:** Close with `felt off ralph-loop-autonomous-portolan-84bd75bf -r "..."`, then `kill $PPID`.

---

## Desired State

A procedurally generated portolan-style map running in Three.js that feels authentically hand-drawn, not algorithmic.

**Vellum substrate:**
- Warm cream base (#F5EEE1 center, aging toward edges)
- Organic cloud-like variation (beige tones, not gray)
- Edge darkening where hands would hold
- WebGL shader, not texture image

**Coastlines (coastline-first architecture):**
- Coastline generated *through* city positions — thread through beads, not independent
- Catmull-Rom spline passes through all cities, midpoint displacement adds organic variation between them
- Smooth at small scale (Chaikin), pronounced bays/peninsulas at large scale
- Scalloped, hand-drawn quality that passes the "squint test"
- **No hex grid** — remove HexGrid.ts entirely, use world coordinates

**Cities:**
- Cities are ports on the coastline — the coastline connects them
- Small port marker (tiny flag or building icon), not hex blocks
- Names perpendicular to coast, in bright manuscript red (see https://gwern.net/red)

**Workers (Marauder's Map style):**
- **Animated ink figures** — small humanoid shapes or footprint pairs, like the Marauder's Map
- **Force simulation** — workers drift/wander near their city, avoiding collision with each other
- **Following names** — worker name in handwritten black ink follows the figure
- **Status indication** — working = figure moving/writing; idle = standing still
- Visual language: ink drawings that came alive, like animated medieval marginalia

**Map composition:**
- Procedurally generated — arbitrarily large. Coastline grows as new cities are placed and "fog of war" recedes.
- Click detection via raycasting to city markers or proximity to workers (not hex grid)
- Seed-based generation for reproducible variation

**Integration:**
- Algorithms ported from Canvas 2D playgrounds to Three.js
- Running in the actual Portolan app (`src/render/`)
- Replaces current photorealistic terrain approach

**Quality bar:**
When you look at the generated map, it should evoke the reference portolan charts in `reference/portolan-charts/`. Not a copy, but the same family of aesthetic.

## Context

**STATUS: INTEGRATION PHASE** — Playground work is complete. Port algorithms to Three.js.

**Live app:**
- `http://localhost:5173` — Portolan running in browser
- Start with `./dev.sh` (frontend + backend)

**Playground (reference only):**
- `reference/combined-playground.html` — working algorithms to port
- Use as reference for the Canvas 2D implementations, then translate to Three.js

**Reference images:**
- `reference/portolan-charts/*.jpg` — 6 high-res authentic portolan charts
- Read one at random to start each iteration:
  ```bash
  REF=$(ls reference/portolan-charts/*.jpg | awk 'BEGIN{srand()}{a[NR]=$0}END{print a[int(rand()*NR)+1]}')
  ```

**Completed (do not modify):**
- ✓ Rhumb lines — working well, leave them alone

**Playground status (resolved in combined-playground.html):**
- ✓ Vellum shader with warm beige tones
- ✓ Coastline with Chaikin smoothing
- ✓ Rhumb lines from wind roses
- Remaining: port all of this to Three.js

**Existing patterns (to refactor/remove):**
- `src/render/ZoneRenderer.ts` — current Three.js rendering (refactor to coastline-first)
- `src/render/HexGrid.ts` — hex coordinate math (remove eventually)

**Fibers:**
- `design-coastline-first-4c5091aa` — coastline-first architecture + Marauder's Map workers (detailed spec)
- `vellum-design-philosophy-96a07631` — "Weathered Substrate" manifesto
- `portolan-iteration-log-2022b2aa` — cumulative findings (update each iteration)
- `portolan-visual-redesign-bottom-396194d1` — parent spec

## Integration Work

We are in integration phase. Implement the coastline-first architecture with Marauder's Map workers.

**Migration phases:**
1. Remove hex rendering, keep hex coordinates internally for now
2. Implement coastline-through-cities generation (Catmull-Rom spline)
3. City labels perpendicular to coast
4. Worker force simulation + ink figures
5. Remove HexGrid.ts entirely, pure world coordinates

**Files to create/modify:**
- `src/render/VellumShader.ts` — port the WebGL vellum shader from playground
- `src/render/CoastlineRenderer.ts` — spline through cities + midpoint displacement + Chaikin
- `src/render/WorkerRenderer.ts` — Marauder's Map ink figures, force simulation
- `src/render/ZoneRenderer.ts` — integrate new renderers, remove hex blocks + terrain texture
- Eventually remove: `src/render/HexGrid.ts`

**Technical approach:**
- Coastline: `CatmullRomCurve3` through city positions, then sample and displace
- Workers: force-directed positions (attract to city, repel from each other, random wander, damping)
- Ink figures: procedural shapes with slight wobble/variation, or canvas-rendered sprites

**The playground is reference, not the work surface.** All edits go to `src/render/`.

## Skills

ALWAYS invoke before substantial work:
- `/webapp-testing` — for Chrome screenshots and interaction
- `/frontend-design` — for visual implementation
- `/refine` — if major rework needed
