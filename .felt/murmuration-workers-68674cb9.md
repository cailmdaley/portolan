---
title: Murmuration workers
status: open
kind: spec
priority: 2
created-at: 2026-02-03T23:50:35.237418+01:00
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

Replace ship sprites with particle swarms — ink droplets floating above the vellum, moving like a murmuration. Workers become living clouds of suspended pigment.

### Visual Concept

Each worker is a swarm of 50-100 particles:
- **Ink droplets** — opaque, organic shapes like pigment suspended in water
- **Float above the map** — 3D cloud hovering over worker position
- **Soft blob shadow** — single diffuse shadow on the vellum beneath, grounding the swarm
- **Label below** — worker name floats beneath the swarm (existing CSS2D label pattern)

The swarm IS the worker's identity. No ship icon, no central marker. Position and label differentiate workers.

### Color

**Idle state:** Deep ink `#2E2A26` (dark brown-black)
**Working state:** Shift toward sepia/gold `#8A6B2A` (warmer, brighter)

All workers use the same color palette. Differentiated by position only.

### Animation

**Motion model:** Noise-based (Perlin/Simplex)
- Each particle samples a 3D noise field for velocity
- Smooth, organic flow — classic murmuration aesthetic
- Noise offset by time creates continuous drift

**Idle state:**
- Slow, lazy drift
- Particles stay in a compact sphere
- Gentle orbital motion around center
- Occasional individual wander

**Working state:**
- Faster movement (higher noise sampling rate or amplitude)
- Sphere expands (breathing)
- More chaotic paths
- Color shifts warmer

**Transition:** Smooth interpolation between idle/working parameters over ~500ms.

### Technical Implementation

**Rendering:** Three.js `Points` with `PointsMaterial`
- Custom texture for soft circular droplet shape
- Single draw call per swarm (efficient)
- Position attribute updated each frame from noise

**Swarm class:** `src/render/WorkerSwarm.ts`
```typescript
class WorkerSwarm {
  points: Points
  positions: Float32Array
  center: Vector3  // anchor position from ZoneRenderer
  activity: number  // 0-1, drives speed/spread/color

  update(deltaTime: number): void
  setActivity(level: number): void
  dispose(): void
}
```

**Integration:** Replace ship sprite creation in `ZoneRenderer.renderCity()` and `renderOrphanWorker()` with swarm creation. Existing `ShipSpritesManager` can be removed or deprecated.

**Noise:** Use simplex-noise package or implement simple 3D Perlin.

**Shadow:** Semi-transparent circle mesh below the swarm center.

### Performance

With ~5 workers × 75 particles = 375 points total, performance should be fine. Points are GPU-accelerated. If needed:
- Reduce particle count at far zoom
- Skip update for off-screen swarms

### Acceptance Criteria

1. Workers render as particle swarms, not ships
2. Idle workers: slow, compact, dark ink color
3. Working workers: faster, expanded, warmer color
4. Smooth transition between states
5. Soft blob shadow grounds each swarm
6. Labels still visible below swarms
7. Click detection still works (hit test swarm bounds)
8. Performance: 60fps with 5+ swarms visible
9. Tests pass: `cd server && npm test`

## Context

### Files to modify

- `src/render/ZoneRenderer.ts` — Replace ship sprite code with swarm creation
- `src/render/ShipSpritesManager.ts` — Can be deprecated/removed
- `src/render/WorkerSwarm.ts` — New file, the swarm implementation
- `index.html` — May need CSS adjustments for label positioning

### Patterns to follow

- **Existing Points usage:** Check Three.js docs for Points + PointsMaterial
- **Animation loop:** See `ZoneRenderer.animate()` for existing per-frame update pattern
- **Disposal:** Follow `disposeObject()` pattern for cleanup

### Reference

- [Three.js Points](https://threejs.org/docs/#api/en/objects/Points)
- [Simplex noise](https://github.com/jwagner/simplex-noise.js)

## Skills

Activate `/frontend-design` if design questions arise about the visual treatment.
