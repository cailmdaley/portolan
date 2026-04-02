---
title: Scene + Hex Rendering
status: closed
tags:
    - hexarchy-v2
created-at: 2026-01-18T00:39:11.919874+01:00
closed-at: 2026-01-18T02:01:20.005692+01:00
---

(scene-hex-rendering)=
## Goal

Three.js scene with hex grid rendering, camera controls, and Cartographic Warmth aesthetic.

## Design

### Files

```
src/
  main.ts              # Bootstrap, scene setup, render loop
  render/
    HexGrid.ts         # Coordinate math (axial ↔ cartesian)
    ZoneRenderer.ts    # Hex meshes, labels, visual styling
    Camera.ts          # Pan, zoom, focus
  state/
    types.ts           # City, Session, HexCoord interfaces
```

### Visual Language: Cartographic Warmth

*Ancient, sun-bleached, archaeological. Not a dashboard — a living map.*

**Palette** (from moodboard):
| Color | Hex | Use |
|-------|-----|-----|
| Sand | #E8DCC4 | Background, idle hexes |
| Ochre | #C4956A | City hexes |
| Terracotta | #B87333 | Warm accents |
| Verdigris | #4A7C6F | Working state |
| Lapis | #5B7C99 | Cool accents |
| Umber | #6B5344 | Labels, borders |
| Sepia | #8B7355 | Dormant state |
| **Vermillion** | **#C54B3D** | **Attention — vivid** |

Everything sun-faded except vermillion. Attention alone stays vivid.

**Typography:**
- Italiana — display, humanist elegance
- Crimson Pro — body, warm, readable
- National Park — labels, surveyor's marks

**Texture:**
- Paper/parchment plane underneath the grid
- Subtle noise/grain in post-processing
- Hex edges with slight wobble (hand-drawn feel, not cartoonish)
- Warm lighting — desert sun, amber glow

### HexGrid.ts

Coordinate math. Port from v1.

```typescript
interface HexCoord { q: number; r: number }
interface CartesianCoord { x: number; z: number }

class HexGrid {
  axialToCartesian(hex: HexCoord): CartesianCoord
  cartesianToHex(x: number, z: number): HexCoord
  roundHex(hex: HexCoord): HexCoord
  distance(a: HexCoord, b: HexCoord): number
  getNeighbors(hex: HexCoord): HexCoord[]
  getHexRing(center: HexCoord, radius: number): HexCoord[]
}
```

**Port from:** `@hexarchy/src/scene/HexGrid.ts`

### ZoneRenderer.ts

Renders hexes with Cartographic Warmth styling.

```typescript
class ZoneRenderer {
  constructor(scene: Scene, hexGrid: HexGrid)

  renderCity(city: City): void      // Ochre hex, label, fiber badge
  renderWorker(session: Session): void  // Smaller hex around city
  updateState(cities: City[], sessions: Session[]): void
  getHexAtPosition(x: number, z: number): HexCoord | null
}
```

**Hex geometry:**
- Flat-top hexagons
- City hexes: larger, ochre fill, umber border
- Worker hexes: smaller, positioned in ring around city
- Labels: National Park font, carved-stone feel

**Materials:**
- MeshStandardMaterial with roughness (not shiny)
- Subtle bevel on hex edges
- Paper texture plane at y=-0.1

### Camera.ts

Orthographic camera with pan/zoom.

```typescript
class Camera {
  constructor(canvas: HTMLCanvasElement)

  pan(dx: number, dy: number): void
  zoom(delta: number): void
  focusOn(position: CartesianCoord): void
  screenToWorld(screenX: number, screenY: number): CartesianCoord
}
```

Controls:
- Mouse drag to pan
- Scroll wheel to zoom
- Click handling delegated to main.ts

### main.ts

Bootstrap and render loop.

```typescript
// Setup
const scene = new Scene()
const camera = new Camera(canvas)
const hexGrid = new HexGrid(50, 1.0)
const renderer = new ZoneRenderer(scene, hexGrid)

// Render loop
function animate() {
  requestAnimationFrame(animate)
  renderer.render(camera)
}

// Click handling
canvas.addEventListener('click', (e) => {
  const worldPos = camera.screenToWorld(e.clientX, e.clientY)
  const hex = hexGrid.cartesianToHex(worldPos.x, worldPos.z)
  // Dispatch to store or emit event
})
```

### Post-processing

Subtle effects for the cartographic feel:
- Vignette (darken edges)
- Film grain (very subtle)
- Color grading (warm shift)

Use Three.js EffectComposer if needed, or keep it simple with CSS filters on canvas.

---

## Verification

Test the system:

- Does `npm run dev` start Vite and show the canvas?
- Does the hex grid render with correct geometry?
- Are the colors matching Cartographic Warmth palette?
- Does pan/zoom feel smooth?
- Can you see mock cities and workers on the grid?
- Do labels render readably at different zoom levels?
- Does it feel like an ancient map, not a dashboard?

Try breaking it:
- Rapid zoom in/out
- Pan to edge of grid
- Many hexes rendered (performance)
- Window resize

---

## Stopping Criteria

- The aesthetic genuinely matches Cartographic Warmth
- All verification items pass
- A full exploration yields nothing to implement, fix, or improve
- No edits were made in that final pass
