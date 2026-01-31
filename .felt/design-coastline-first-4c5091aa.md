---
title: 'Design: coastline-first architecture + Marauder''s Map workers'
status: open
kind: spec
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T20:40:49.621274+01:00
---

# Coastline-First Architecture + Marauder's Map Workers

## Vision

Cities are ports on a coastline. The coastline is generated *through* city positions — it connects them like a thread through beads. No hex grid. Workers are animated ink figures that wander near their city, Marauder's Map style.

## Inspirations

- **Marauder's Map (Harry Potter)** — parchment with ink footprints that move, showing where people are in real-time. Names follow the figures. Living, magical feel.
- **Authentic portolan charts** — cities as ports with names perpendicular to coast, coastline hatching, rhumb lines.

## Architecture Changes

### Remove Hex Grid

Current: `HexGrid.ts` provides coordinate snapping, click regions, positioning math.

New:
- Cities have world positions (derived from their index/hash or explicit placement)
- Coastline is a spline/curve passing through all city positions
- Click detection via raycasting to city markers or proximity to workers

### Coastline Generation

Current: Procedural coastline independent of cities.

New:
- Input: array of city world positions
- Output: smooth curve (Catmull-Rom spline?) passing through all cities
- Midpoint displacement adds organic variation between cities
- Hatching perpendicular to coast at each segment

### City Rendering

Current: Hex block + banner sprite floating above.

New:
- Small port marker on coastline (maybe a tiny flag or building icon?)
- Name perpendicular to coast, in manuscript red
- No hex, no banner

### Worker Rendering — Marauder's Map Style

Current: Smaller hex blocks clustered around city.

New:
- **Animated ink figures** — small humanoid shapes or footprint pairs
- **Force simulation** — workers drift/wander near their city, avoiding collision
- **Following names** — worker name in handwritten style follows the figure
- **Status indication** — working = figure is moving/writing; idle = standing still
- **Animation** — smooth interpolation, maybe slight bobbing or ink-wobble effect

Visual language: looks like ink drawings that came alive. Not cartoon characters — more like the animated marginalia of a medieval manuscript.

## Technical Approach

### Spline-Based Coastline

```typescript
interface City {
  id: string
  name: string
  position: { x: number, z: number }  // World coords on coastline
}

function generateCoastlineThroughCities(cities: City[]): CatmullRomCurve3 {
  // Sort cities by angle from center or by some ordering
  // Create control points
  // Return smooth curve
}
```

### Force-Directed Workers

```typescript
interface Worker {
  id: string
  name: string
  cityId: string
  position: { x: number, z: number }  // Current animated position
  velocity: { x: number, z: number }
  status: 'idle' | 'working'
}

function updateWorkerPositions(workers: Worker[], cities: City[], dt: number) {
  // For each worker:
  // - Attract toward home city
  // - Repel from other workers
  // - Random wandering force
  // - Damping
  // - Constrain to stay near coast (on land side)
}
```

### Ink Figure Sprites

Could be:
1. **Sprite sheets** — pre-drawn animation frames
2. **Procedural** — simple shapes (circle head, line body, two legs) drawn each frame
3. **SVG/Canvas** — vector figures rendered to texture

The handwritten/ink aesthetic suggests option 2 or 3 — generated to look hand-drawn, with slight wobble/variation.

## Open Questions

1. How are cities ordered along the coastline? Alphabetically? By activity? By spatial hash?
2. Should the coastline be closed (island) or open (continent edge)?
3. How close do workers stay to their city? What's the "wandering radius"?
4. When a worker is working, what does the animation look like? Quill writing? Footprints moving?
5. Do workers leave "trails" like the Marauder's Map footprints?

## Migration Path

1. **Phase 1:** Remove hex rendering, keep hex coordinates internally for now
2. **Phase 2:** Implement coastline-through-cities generation
3. **Phase 3:** City labels perpendicular to coast
4. **Phase 4:** Worker force simulation + ink figures
5. **Phase 5:** Remove HexGrid.ts entirely, pure world coordinates
