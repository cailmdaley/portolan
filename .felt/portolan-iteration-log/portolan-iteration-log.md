---
title: Portolan iteration log
status: closed
depends-on:
    - ralph-loop-autonomous-portolan
created-at: 2026-01-31T18:32:19.108908+01:00
closed-at: 2026-02-03T00:19:37.81931+01:00
---

(portolan-iteration-log)=
# Portolan Visual Iteration Log

Cumulative findings from Ralph iterations on the portolan visual redesign.

---

## Iteration 23 — Separate Coastlines Per Origin (2026-01-31)

**Reference:** default-4.jpg — portolan showing distinct landmasses (Europe, Africa) as separate filled regions

**Observation:** Green land fill was rendering as independent triangular shapes that didn't interact properly with coastlines. Each fill used a "top-edge-to-coastline" approach assuming land is "above" the coastline — wrong for closed polygon landmasses.

**Contribution:** Refactored coastline rendering for proper per-origin landmasses:

**Architecture changes:**
1. **Closed polygon fill** — Land is now INSIDE the spline loop, not top-edge-to-coastline. `createLandFillGeometry()` simply traces the coastline and closes the path.

2. **Per-origin coastlines** — `ZoneRenderer` now groups cities by `originId` and creates separate coastlines for each. Each origin is a distinct island/continent.

3. **Corrected normals** — For CCW wound polygons:
   - Hatching uses left normal (-dy, dx) → points OUTWARD into sea
   - Labels use right normal (dy, -dx) → points INWARD into land

**Technical changes:**
```typescript
// ZoneRenderer.ts
- coastlineGroup: Group → coastlineGroups: Map<string, Group>
- coastlinePoints: CoastlinePoint[] → coastlinePointsByOrigin: Map<string, CoastlinePoint[]>
- createCoastline() → createCoastlineForOrigin(originId, positions, seed)
- updateState() now groups cities by originId before creating coastlines

// CoastlineRenderer.ts
- createLandFillGeometry() now fills closed polygon (was top-edge fill)
- Hatching normal calculation simplified (no more "flip if Z > 0" heuristic)
- getCoastlineAngleAt() uses right normal for label positioning
```

**Result:** Land masses are now proper filled polygons per origin. When multiple origins exist (local + remote), each renders as a separate continent/island. Hatching correctly points into the sea.

**Known issue:** Some label orientations still appear mirrored at certain angles — the text flip logic needs additional work for edge cases.

**Related fibers closed:**
- `green-shading-must-interact-445889aa` — green fill now properly defines landmass
- `remote-origins-render-as-e18ca14d` — foundation for separate continents per origin

---

## Iteration 22 — Fix Worker Footprints (2026-01-31)

**Reference:** yale_16762930.jpg — Yale portolan with bicolored rhumb lines

**Observation:** Iteration 21 implemented footprint trail system, but footprints were not visually rendering despite code compiling. Workers appeared to be stationary dots.

**Root cause analysis:**
1. Workers oscillate due to wandering force changing direction
2. `footprintSpacing = 0.25` was larger than typical oscillation amplitude
3. Workers would drift ~0.15 units, then reverse before reaching 0.25 threshold
4. Result: footprints never placed because distance threshold never reached

**Fixes applied in `WorkerRenderer.ts`:**

| Parameter | Before | After | Reason |
|-----------|--------|-------|--------|
| `footprintSpacing` | 0.25 | 0.12 | Smaller than oscillation amplitude |
| `wanderStrength` | 0.5 | 1.5 | More visible movement |
| `damping` | 0.90 | 0.85 | Less velocity decay = more drift |
| `wanderFrequency` | 0.001 | 0.003 | Faster direction changes |
| velocity threshold | 0.01 | 0.001 | More permissive |

**Result:** Workers now leave visible ink footprint trails as they wander. Footprints fade over ~2.3 seconds. The Marauder's Map effect is working — workers drift near their cities with subtle trailing footprints.

**Remaining:**
- Worker labels could be more visible
- Rhumb lines very faint compared to authentic portolans
- Consider tuning footprint visual appearance

---

## Iteration 21 — Footprint Trails + Infinite Map (2026-01-31)

**Reference:** default.jpg — Mediterranean portolan

**Contribution:**

1. **Worker visual overhaul (partial):**
   - Replaced humanoid stick figures with footprint trail system
   - Workers now have small position dot + trail of footprints that fade over time
   - Footprints created when worker moves 0.25 world units, fade over ~3 seconds
   - Trail rotates to face movement direction
   - **Issue:** Footprints not visually rendering despite code compiling — needs debugging

2. **Infinite map canvas:**
   - User requested infinite map instead of square bounds
   - Increased vellum plane from 50 to 500 world units
   - Increased rhumb lines/coastline radius from 50 to 250
   - Map now extends well beyond visible area at any zoom level

**Remaining work:**
- Debug footprint trail rendering (velocity threshold? layer ordering?)
- Worker names need separate zoom scaling (per user feedback)
- Proper Marauder's Map aesthetic still pending

---

## Iteration 18 — Remove Hex Meshes, Port-Style City Markers (2026-01-31)

**Reference:** — (architecture work, removing game-board aesthetic)

**Observation:** Cities were rendering as 3D hexagonal blocks, creating a game-board aesthetic. The spec calls for "small port markers (tiny flag or building icon)" with "names perpendicular to coast, in bright manuscript red."

**Contribution:** Replaced 3D hex extrusions with port-style markers:

**Visual changes:**
1. **Port markers:** Simple circles (gold active, brown dormant) with dark ink outline
2. **Perpendicular labels:** City names in manuscript red (#A0171B), rotated perpendicular to coastline
3. **Removed:** 3D hex extrusions, banner-style labels, floating sprites

**Technical approach:**
- `CircleGeometry(0.2)` for port marker + outline ring (`CircleGeometry(0.25)`)
- `createPortLabel()` renders flat text on transparent canvas
- `getCoastlineAngleAt()` calculates perpendicular angle for label rotation
- Labels positioned 0.8 units inland from city position

**Code cleanup:**
- Removed unused `SpriteMaterial`, `Sprite` imports
- Removed `cityBannerImage` loading
- Removed `labelSprite`, `baseScale` from HexMeshData interface
- Simplified `animate()` method (no longer needs label scaling)

**Result:** Cities now read as ports on a navigation chart — small markers with red perpendicular names — rather than game pieces. The aesthetic shift from "game board" to "portolan chart" continues.

**Remaining work:**
- Replace worker hex blocks with Marauder's Map ink figures
- Worker force simulation (wander near city)
- Eventually remove HexGrid.ts entirely

---

## Iteration 17 — Increase Coastline Visibility (2026-01-31)

**Reference:** yale_16762930.jpg — Yale portolan showing prominent hatching and coastline stroke

**Observation:** Coastline was rendering but barely visible. The hatching and stroke were too subtle compared to authentic portolan charts where the "comb teeth" are a defining visual feature.

**Contribution:** Increased coastline visibility parameters in `ZoneRenderer.ts`:

**Parameter changes:**
```typescript
{
  hatchDensity: 100 → 150,      // Denser tick marks
  hatchLength: 0.5 → 0.6,       // Longer hatching
  hatchOpacity: 0.5 → 0.75,     // More visible
  hatchWidth: 1.5 → 2.0,        // Thicker strokes
  landOpacity: 0.10 → 0.15,     // Stronger land tint
  coastlineOpacity: 0.7 → 0.9,  // Prominent coastline
  coastlineWidth: 2.0 → 2.5,    // Thicker main stroke
}
```

**Result:** Coastline with hatching now reads clearly as authentic portolan "comb teeth." The land-sea boundary is much more defined. The coastline passes through city positions forming a coherent curve.

**Remaining work:**
- Perpendicular city labels
- Replace hex blocks with small port markers
- Marauder's Map style workers

---

## Iteration 16 — Coastline-Through-Cities Foundation (2026-01-31)

**Reference:** — (architecture work, not visual reference)

**Contribution:** Implemented the foundation for coastline-through-cities:
- Added `CityPosition` interface to `CoastlineRenderer.ts`
- Added `catmullRomSpline()` function for smooth curves through city positions
- Modified `createCoastline()` to accept `cityPositions` parameter
- Updated `ZoneRenderer.updateState()` to regenerate coastline when cities change

The coastline now passes through city positions using Catmull-Rom interpolation with midpoint displacement for organic variation between cities.

---

## Iteration 15 — Architecture Pivot: Coastline-First + Marauder's Map (2026-01-31)

**Reference:** default-3.jpg — Mediterranean portolan with port names perpendicular to coast

**Observation:** Started to port perpendicular coastline labels to Three.js. Modified `CoastlineRenderer.ts` to expose coastline points and added `getCoastlineAngleAt()` helper for calculating perpendicular angles.

**Discussion surfaced fundamental question:** Cities aren't on coastlines — they're placed at hex positions, while coastline is procedurally generated independently. The hex grid itself may not be needed for the portolan aesthetic.

**Decision:** Coastline-first architecture. Cities are ports on the coast. The coastline is generated *through* city positions, not independently. Drop hex grid entirely.

**New vision for workers:** Marauder's Map style — animated ink figures that wander near their city via force simulation. Living map, not game board.

**Contributions:**
- Added `CoastlinePoint` and `CoastlineResult` types to `CoastlineRenderer.ts`
- Added `getCoastlineAngleAt()` helper function
- Filed design spec: `design-coastline-first-4c5091aa`

**Next steps (from spec):**
1. Remove hex rendering (keep coordinates temporarily)
2. Implement coastline-through-cities generation (spline-based)
3. City labels perpendicular to coast
4. Worker force simulation + ink figure animation
5. Remove HexGrid.ts entirely

---

## Iteration 14 — Port Coastline Hatching to Three.js (2026-01-31)

**Reference:** default-2.jpg — Mediterranean portolan with characteristic "comb teeth" hatching along coastlines

**Observation:** The Three.js app had vellum and rhumb lines, but no coastlines. The playground algorithms for coastline generation (midpoint displacement + Gaussian smoothing) and hatching (perpendicular tick marks) needed porting.

**Contribution:** Created `src/render/CoastlineRenderer.ts` — full port of coastline system:

**Technical approach:**
- Procedural coastline using midpoint displacement (4 iterations)
- Gaussian-weighted moving average smoothing for hand-drawn feel
- Hatching via `BufferGeometry` + `LineSegments` — perpendicular tick marks distributed along path
- Land fill via `ShapeGeometry` above coastline with subtle green tint
- Seeded RNG (mulberry32) for reproducibility

**Key parameters:**
```typescript
{
  seed: 42,
  mapRadius: 50,
  hatchDensity: 100,
  hatchLength: 0.5,
  hatchOpacity: 0.5,
  landOpacity: 0.10,
  coastlineOpacity: 0.7,
  coastlineColor: 0x2a2420,  // Dark brown ink
  landColor: 0x3a6a4a,       // Olive green tint
}
```

**Integration:**
- Added `coastlineGroup` to `ZoneRenderer.ts`
- Positioned at y=-0.02 (above rhumb lines, below hexes)
- Coastline spans full map width with natural variation

**Result:** The map now has the characteristic portolan coastline with "comb teeth" hatching. The perpendicular tick marks create the signature textural fringe that defines land-sea boundaries in authentic charts.

**Remaining work:**
- Port mountains to Three.js
- Port coastline labels (perpendicular text)
- Islands support
- Dynamic coastline tied to city positions

---

## Iteration 13 — Two-Tone Rhumb Lines (2026-01-31)

**Reference:** default-3.jpg — Mediterranean portolan with clear black + red rhumb line network

**Observation:** Authentic portolan charts use two distinct line colors: black/ink for the main network and deep red for cardinal direction emphasis. The previous iteration used all brown tones (sienna, darker brown) which read as monochromatic at a glance.

**Contribution:** Updated `src/render/RhumbRenderer.ts` color scheme:

**Color changes:**
```typescript
{
  primary: 0x2A2420,      // Dark ink black (was sienna)
  secondary: 0x3D3530,    // Slightly lighter black (was darker brown)
  accent: 0x8B2323,       // Deep manuscript red (was green)
}
```

**Opacity adjustment:** Cardinal accent lines now use `primaryOpacity * 2.5` (was 1.2) to ensure red lines are prominently visible against the black network.

**Result:** The rhumb lines now have the characteristic portolan two-tone appearance — dark ink network with red cardinal accents that stand out against the vellum background. This directly matches what's visible in the reference charts.

**Remaining work:**
- Port coastlines to Three.js
- Port mountains, hatching, labels
- Revisit dynamic rhumb line design

---

## Iteration 11 — Port Rhumb Lines to Three.js (2026-01-31)

**Reference:** default-2.jpg — Mediterranean portolan with dense rhumb line network radiating from wind roses

**Observation:** The rhumb line network is THE defining visual characteristic of portolan charts. Without them, even with perfect vellum and coastlines, the map doesn't read as "portolan." The Three.js app had vellum but no rhumb lines — a critical missing element.

**Contribution:** Created `src/render/RhumbRenderer.ts` — Three.js port of the rhumb lines and compass roses:

**Technical approach:**
- `LineSegments` with `LineBasicMaterial` for the rhumb lines
- `ShapeGeometry` for compass rose directional points
- `CircleGeometry` for central rose ornaments
- Seeded random (mulberry32) for reproducible rose positions

**Rose structure:**
- Primary roses: 2 (default), 16 directions, higher opacity
- Secondary roses: 6 (default), 8 directions, lower opacity
- Cardinal directions (N/S/E/W) get accent color (green)
- Layered compass rose: 32→16→8→4 point directions, central ornament

**Color scheme (from authentic portolan charts):**
```typescript
{
  primary: 0x8B4513,      // Sienna
  secondary: 0x6B4423,    // Darker brown
  accent: 0x2A5A2A,       // Green for cardinals
  cardinal: 0x2A5A2A,
  intercardinal: 0x8B4513,
  intermediate: 0x6B4423,
  tertiary: 0xC8A878,     // Light tan
  gold: 0x9A7B35,
}
```

**Integration:**
- Added `RhumbRenderer.ts` import to `ZoneRenderer.ts`
- Created rhumb group in constructor, positioned at y=-0.04 (above vellum, below hexes)
- Opacity reduced for integration (0.35/0.20 vs playground's 0.45/0.25)

**Result:** The map now has the characteristic portolan rhumb line web. Compass roses anchor the network visually. The transformation is dramatic — it immediately reads as a navigation chart.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added (playground)**
4. ~~No rhumb lines~~ **DONE — ported to Three.js**
5. ~~Need to combine layers~~ **DONE**
6. ~~Vellum shader~~ **PORTED**
7. ~~Rhumb lines~~ **PORTED**
8. Port coastlines to Three.js (next logical step)
9. Port mountains, hatching, labels to Three.js

---

## Iteration 10 — Port Vellum Shader to Three.js (2026-01-31)

**Reference:** yale_1015869.jpg — warm cream vellum substrate with organic variation

**Observation:** The playground algorithms are mature. Time to port to the actual Three.js app. The most foundational element is the vellum background — all other portolan elements layer on top of it.

**Contribution:** Created `src/render/VellumShader.ts` — Three.js ShaderMaterial port of the playground vellum shader:

**Technical approach:**
- Vertex shader: simple passthrough with UV coordinates
- Fragment shader: full port of playground's procedural vellum texture
  - Simplex noise with FBM for organic cloud-like variation
  - Edge darkening effect (where hands would hold vellum)
  - Corner wear effect (more pronounced aging at corners)
  - Fine grain noise for paper texture
  - Warm tint added to darker areas

**Shader uniforms:**
```typescript
{
  uCenterColor: vec3,  // Warm cream #f5eee1
  uWarmth: float,      // Warm cloud intensity (0.12)
  uEdgeDark: float,    // Edge darkening (0.25)
  uCloudInt: float,    // Cool cloud intensity (0.12)
  uAspect: vec2        // Width/height ratio for proper scaling
}
```

**API:**
```typescript
// Create vellum plane
createVellumPlane(width: number, height: number, params?: VellumParams): Mesh

// Update params at runtime
updateVellumParams(mesh: Mesh, params: Partial<VellumParams>): void
```

**Integration:**
- Updated `ZoneRenderer.ts` to import `createVellumPlane`
- Replaced `createGroundPlane()` — removed terrain.png texture loading
- Vellum plane positioned at y=-0.05, just below hex level

**Result:** The photorealistic terrain texture is replaced with authentic portolan-style vellum. The warm cream background with subtle organic variation provides the correct substrate for the portolan aesthetic.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added**
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. ~~Need Three.js port~~ **STARTED — vellum shader ported**
7. ~~City names perpendicular to coast~~ **DONE** (in playground)
8. Port flags/markers along coast
9. ~~More elaborate compass roses~~ **DONE** (in playground)
10. Scale bars and decorative cartouches
11. ~~Coastline hatching (comb teeth)~~ **DONE** (in playground)
12. ~~Inland mountains/terrain~~ **DONE** (in playground)
13. ~~Color-coded islands~~ **DONE** (in playground)
14. Port remaining playground elements to Three.js (rhumb lines, coastlines, etc.)

---

## Iteration 9 — Colored Islands (2026-01-31)

**Reference:** default.jpg — islands rendered in distinct colors (vermillion, turquoise, ochre, olive)

**Observation:** Authentic portolan charts color-code islands with distinct, saturated hues for identification and navigation. Looking at default.jpg, islands appear in vermillion red, turquoise/teal, ochre/gold, and olive green. This is in contrast to the mainland which uses a subtle tint. The color-coding serves both aesthetic and functional purposes — mariners could identify islands by color from a distance.

**Contribution:** Added island color palette to `reference/combined-playground.html`:

**Technical approach:**
- `ISLAND_COLORS` array defines 8 authentic portolan colors: vermillion, turquoise, ochre, olive, sienna, mauve, sage, russet
- Color assignment uses seeded RNG for consistency across renders
- Colors shuffled per seed so different maps get different color arrangements
- Island opacity is higher than mainland (3.5× land opacity, capped at 85%) for saturated appearance

**Color palette:**
```javascript
const ISLAND_COLORS = [
  { fill: '#C85450', name: 'vermillion' },   // Red
  { fill: '#4A8B8B', name: 'turquoise' },    // Teal
  { fill: '#B8963C', name: 'ochre' },        // Gold
  { fill: '#5A7B4A', name: 'olive' },        // Green
  { fill: '#8B6B4A', name: 'sienna' },       // Brown
  { fill: '#6B5A8B', name: 'mauve' },        // Purple (rare)
  { fill: '#7B8B5A', name: 'sage' },         // Sage
  { fill: '#8B5A5A', name: 'russet' }        // Brick
];
```

**Result:** Islands now pop visually with distinct identity. Each island has a unique color from the palette, creating the characteristic portolan archipelago aesthetic. The saturated colors contrast well with the subtle mainland tint and vellum background.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added**
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. Need Three.js port
7. ~~City names perpendicular to coast~~ **DONE**
8. Port flags/markers along coast
9. ~~More elaborate compass roses~~ **DONE**
10. Scale bars and decorative cartouches
11. ~~Coastline hatching (comb teeth)~~ **DONE**
12. ~~Inland mountains/terrain~~ **DONE**
13. ~~Color-coded islands~~ **DONE**

---

## Iteration 8 — Inland Mountains / Terrain (2026-01-31)

**Reference:** default-4.jpg — prominent green mountain ranges filling the land area above coastline

**Observation:** Authentic portolan charts feature stylized mountain ranges depicted as continuous chains of overlapping triangular peaks. These fill the land area and give the map visual weight — without them, land appears flat and empty. Mountains use a two-tone coloring (shadow/light sides) with fine ink outlines, creating depth through overlap.

**Contribution:** Added inland mountain system to `reference/combined-playground.html`:

**Technical approach:**
- `drawInlandMountains()` generates multiple rows of mountains from canvas top down to coastline
- Mountains drawn back-to-front for proper overlap (atmospheric perspective)
- Each mountain is a two-tone triangle: darker shadow side (left) + lighter side (right)
- Rows are staggered (every other row offset by 50%) for continuous chain effect
- Mountains overlap significantly (~40% of width) eliminating gaps
- Fine outline strokes and central ridge lines for portolan authenticity
- Land boundary checking ensures mountains only appear on land

**New parameters:**
```javascript
{
  showMountains: true,
  mountainRows: 3,       // number of mountain chain rows
  mountainsPerRow: 12,   // density per row (auto-calculated from width)
  mountainHeight: 25,    // peak height in px
  mountainWidth: 18      // base width in px
}
```

**Colors (authentic olive-green palette):**
```javascript
{
  shadow: '#4a6a3a',    // darker olive for shadow side
  light: '#6a8a5a',     // lighter green for lit side
  outline: '#3a4a2a'    // dark outline strokes
}
```

**Preset variations:**
- Dense: 4 rows, 18/row, 20px height, 14px width (packed continuous chains)
- Sparse: 2 rows, 8/row, 30px height, 22px width (prominent individual peaks)
- Dramatic: 4 rows, 14/row, 32px height, 20px width

**Result:** Land areas now have substantial visual weight. The overlapping mountain chains read as continuous terrain features rather than isolated symbols. Combined with coastline hatching and labels, the land-sea distinction is much stronger.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added**
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. Need Three.js port
7. ~~City names perpendicular to coast~~ **DONE**
8. Port flags/markers along coast
9. ~~More elaborate compass roses~~ **DONE**
10. Scale bars and decorative cartouches
11. ~~Coastline hatching (comb teeth)~~ **DONE**
12. ~~Inland mountains/terrain~~ **DONE**

---

## Iteration 7 — Coastline Hatching / Comb Teeth (2026-01-31)

**Reference:** yale_1015869.jpg — dense perpendicular tick marks ("comb teeth") along entire coastline edge

**Observation:** Beyond the city name labels, authentic portolan charts have a distinctive textural element: hundreds of tiny perpendicular strokes along the entire coastline, creating a "fringe" or "comb teeth" effect. This is different from the labels — it's a decorative hatching that gives the coastline a hand-drawn, inked quality. The strokes radiate from the coast into the land (for mainland) or outward (for islands).

**Contribution:** Added coastline hatching system to `reference/combined-playground.html`:

**Technical approach:**
- `drawCoastlineHatching(points, isIsland)` draws perpendicular tick marks along any coastline
- Calculates total path length and distributes hatches evenly with slight jitter for organic feel
- For mainland: hatches point into land (upward/negative Y direction)
- For islands: hatches point outward from island center
- Length variation (0.7–1.3×) for hand-drawn appearance
- Applied to both mainland coastline and all islands

**New parameters:**
```javascript
{
  showHatching: true,
  hatchDensity: 80,    // number of tick marks along mainland coast
  hatchLength: 4,      // length in px
  hatchWidth: 0.5,     // stroke width
  hatchOpacity: 0.6    // transparency
}
```

**Color:** `rgba(42, 36, 32, opacity)` — dark brown matching coastline stroke

**Preset variations:**
- Dense: 150 hatches, 3px length, 0.4 width (packed authentic look)
- Sparse: 40 hatches, 5px length, 0.6 width (cleaner)
- Dramatic: 100 hatches, 5px length, 0.5 width

**Island scaling:** Island hatch density scales with coastline length relative to canvas, ensuring proportional coverage on smaller land masses.

**Result:** The hatching adds crucial textural authenticity. Combined with the city labels, the coastline now has the dense, information-rich edge character of real portolan charts.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added**
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. Need Three.js port
7. ~~City names perpendicular to coast~~ **DONE**
8. Port flags/markers along coast
9. ~~More elaborate compass roses~~ **DONE**
10. Scale bars and decorative cartouches
11. ~~Coastline hatching (comb teeth)~~ **DONE**

---

## Iteration 6 — Perpendicular Coastline Labels (2026-01-31)

**Reference:** yale_1015869.jpg — tiny red text radiating perpendicular from coastline into land

**Observation:** The most distinctive visual feature of portolan charts, after rhumb lines, is the dense array of port/city names written perpendicular to the coastline, radiating into the land. These names are rendered in manuscript red — a characteristic medieval color for important text (see https://gwern.net/red for aesthetic context).

**Contribution:** Added coastline label system to `reference/combined-playground.html`:

**Technical approach:**
- `generateCoastlineLabels()` places labels at even intervals along coastline with slight randomization
- For each label position, calculates the coastline tangent using neighboring points
- Derives normal vector perpendicular to tangent, pointing into land (negative Y)
- Rotates text to be perpendicular to coast, reading naturally (not upside-down)

**Label data:**
- Pool of 72 Mediterranean port names (Italian/Greek/Spanish flavor)
- Seeded random selection to avoid duplicates
- Names like: Civita, Portofino, Venezia, Salonicco, Costantinopoli, Trebisonda...

**New parameters:**
```javascript
{
  showLabels: true,
  labelDensity: 18,    // number of labels along coastline
  labelFontSize: 7,    // px
  labelOffset: 4       // px from coastline
}
```

**Color:** `#8B2323` (deep manuscript red) — chosen to evoke the characteristic vermillion/cinnabar ink of medieval manuscripts

**Font:** EB Garamond with fallbacks to Garamond, Times New Roman, serif — humanist letterforms appropriate to the period

**Preset variations:**
- Dense: 25 labels, 6px font, 3px offset (packed like authentic charts)
- Sparse: 10 labels, 9px font, 5px offset (cleaner, more legible)
- Dramatic: 20 labels, 8px font, 4px offset

**Result:** The labels immediately shift the visual character toward authentic portolan. The perpendicular orientation + manuscript red is unmistakably the portolan aesthetic.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added**
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. Need Three.js port
7. ~~City names perpendicular to coast~~ **DONE**
8. Port flags/markers along coast
9. ~~More elaborate compass roses~~ **DONE**
10. Scale bars and decorative cartouches

---

## Iteration 5 — Decorative Compass Roses (2026-01-31)

**Reference:** yale_1015869.jpg — elaborate multi-ring compass roses are prominent visual anchors

**Observation:** The existing compass roses were simple star shapes with basic triangular rays. In authentic portolan charts, compass roses are intricate decorative elements that serve as visual anchors for the rhumb line network. They feature:
- Multiple concentric rings
- Graduated directional points (cardinals longest, tertiaries shortest)
- Two-tone coloring for depth (dark/light halves)
- Central ornamental hub

**Contribution:** Replaced simple roses with `drawElaborateRose()` in `reference/combined-playground.html`:

**Visual structure:**
- Outer decorative rings (size × 1.0 and × 0.85)
- 32-point directions for primary roses, 16-point for secondary
- Layered rendering (back to front):
  1. Tertiary points (32-point, shortest, light tan)
  2. Intermediate points (16-point, medium, darker brown)
  3. Intercardinal points (8-point, longer, sienna)
  4. Cardinal points (4-point, longest, green with inner flourish)
- Central ornament: nested circles (vellum → sienna → gold → vellum)
- Decorative dots between major points on outer ring (primary only)

**Color scheme:**
```javascript
{
  cardinal: '#2A5A2A',      // Green for N/S/E/W
  intercardinal: '#8B4513', // Sienna for NE/SE/SW/NW
  intermediate: '#6B4423',  // Darker brown for 16-point
  tertiary: '#C8A878',      // Light tan for 32-point
  gold: '#9A7B35'           // Center accent
}
```

**Technical approach:**
- `drawRosePoint()` renders two-tone diamond shapes (colored half + vellum half)
- Points oriented with North at top (-π/2 offset)
- Size scaled: primary roses 28px, secondary 16px
- Cardinal points get extra inner triangle flourish

**Result:** Compass roses now read as decorative cartographic elements rather than simple markers. They anchor the rhumb line network visually and contribute significantly to the portolan aesthetic.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added**
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. Need Three.js port
7. City names perpendicular to coast (signature portolan feature)
8. Port flags/markers along coast
9. ~~More elaborate compass roses~~ **DONE**

---

## Iteration 4 — Islands (2026-01-31)

**Reference:** yale_1015869.jpg — Mediterranean portolan showing mainland plus archipelago

**Observation:** Authentic portolan charts depict multiple land masses, not just a single coastline. The Mediterranean especially has islands (Sardinia, Corsica, Sicily, Greek islands) that are essential to the composition.

**Contribution:** Added island generation to `reference/combined-playground.html`:

- **Closed coastline shapes** — islands use the same midpoint displacement + smoothing algorithms as the mainland, wrapped to create closed loops
- **Placement algorithm** — positions islands in the sea area (below main coastline) with minimum separation to prevent overlap
- **Size variation** — configurable min/max size for archipelago variety
- **Consistent styling** — islands share land fill and coastline stroke with mainland

**New parameters:**
```javascript
{
  showIslands: true,
  islandCount: 4,        // target number (actual may be lower due to spacing)
  islandSizeMin: 0.03,   // normalized units
  islandSizeMax: 0.12
}
```

**Technical notes:**
- Island shapes use fractal noise for radius variation, creating organic irregular outlines
- Midpoint displacement adds fine detail (2 iterations)
- Same Gaussian smoothing as mainland for consistent hand-drawn feel
- Placement rejects islands that would overlap others or get too close to coastline
- Tighter packing (1.8× max size separation) allows archipelago feel

**Updated presets:**
- Dense: 6 islands
- Sparse: 2 islands
- Dramatic: 5 islands, larger max size (0.15)

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. ~~Vellum cloudiness~~ **OK**
3. ~~Only single coastline~~ **FIXED — islands added**
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. Need Three.js port
7. City names perpendicular to coast (signature portolan feature)
8. Port flags/markers along coast
9. More elaborate compass roses (multi-ring decorative)

---

## Iteration 0 — Initial State (2026-01-31)

**Reference:** Various portolan charts from Yale Beinecke collection

**Starting point:**
- Vellum playground: WebGL shader, warm tones, edge darkening
- Coastline playground v2: midpoint displacement with spatial variation

**Current best coastline parameters:**
```javascript
{
  featureScale: 3.8,
  featureAmp: 0.3,
  iterations: 5,
  displacement: 0.28,
  roughness: 0.5,
  varFreq: 4,
  varAmt: 0.65,
  bias: 0.12
}
```

**Known issues:**
1. Small-scale detail is choppy — need smoothing
2. Vellum cloudiness should be beige not gray
3. Only single coastline — need islands

**Next steps:**
- Add smoothing pass to coastline generation
- Experiment with Chaikin's algorithm or spline interpolation for smooth curves
- Test different noise functions for organic variation

---

## Iteration 1 — Smoothing Algorithm (2026-01-31)

**Reference:** yale_1015869.jpg — Mediterranean portolan with smooth flowing coastlines

**Problem identified:** Coastlines had high-frequency "fuzz" that looked algorithmic, not hand-drawn. Initial attempt with Chaikin's algorithm had no visible effect.

**Root cause:** At 6 iterations, the midpoint displacement generates ~6400 points. Each segment is <0.2 pixels — sub-pixel rendering masks any smoothing effect.

**Solution:** Moving-average smoothing with Gaussian-weighted window:
```javascript
function smoothPoints(points, windowSize) {
  // Gaussian-weighted average: center points matter more
  for each point:
    sum neighbors within windowSize/2
    weight by distance from center
}
```

Window size scales with point count: `floor(pointCount * 0.01 * 2^(smoothing-1))`

**Key insight:** Fewer iterations + smoothing > many iterations + post-smoothing

**Updated coastline parameters:**
```javascript
{
  featureScale: 2.5,
  featureAmp: 0.12,
  iterations: 4,      // was 6 — reduced for visible smoothing effect
  displacement: 0.35,
  roughness: 0.58,
  varFreq: 3.0,
  varAmt: 0.6,
  bias: 0.15,
  smoothing: 3        // NEW — Gaussian moving average passes
}
```

**Result:** Coastlines now have the smooth, flowing character of authentic portolan charts.

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. Vellum cloudiness should be beige not gray
3. Only single coastline — need islands
4. No rhumb lines — the defining portolan feature

---

## Iteration 2 — Rhumb Lines Playground (2026-01-31)

**Reference:** yale_1015869.jpg and yale_16762930.jpg — the signature web of navigation lines

**Observation:** Rhumb lines are THE defining visual characteristic of portolan charts. They create a crisscross web radiating from compass roses across the entire sea area. Without them, even with perfect coastlines, the map doesn't read as "portolan."

**Contribution:** Created `reference/rhumb-lines-playground.html` — interactive exploration of:

- **Rose layout:** Primary (1-4) and secondary (0-12) compass roses with seeded positions
- **Line directions:** 8/16/32-point compass configurations per rose type
- **Line style:** Separate width/opacity for primary vs secondary roses
- **Colors:** Primary, secondary, and accent (cardinal/intercardinal) colors
- **Rose markers:** Simple dots or elaborate decorative roses

**Key design decisions:**
- Lines extend to canvas edge (authentic portolan behavior)
- Every 4th direction gets accent color (typically green) for cardinals
- Secondary roses avoid clustering near primaries (minimum 80px separation)
- Presets: Classic, Dense, Sparse, Modern

**Default parameters:**
```javascript
{
  primaryRoses: 2,
  secondaryRoses: 6,
  roseSpread: 0.7,
  primaryDirections: 16,
  secondaryDirections: 8,
  primaryWidth: 0.8,
  secondaryWidth: 0.4,
  primaryOpacity: 0.6,
  secondaryOpacity: 0.35,
  primaryColor: '#8B4513',  // sienna
  secondaryColor: '#6B4423',
  accentColor: '#2A5A2A'    // green for cardinals
}
```

**File:** `reference/rhumb-lines-playground.html` — serve with `python3 -m http.server 8889`

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. Vellum cloudiness should be beige not gray
3. Only single coastline — need islands
4. ~~No rhumb lines~~ **PLAYGROUND CREATED**
5. Need to combine layers (vellum + rhumb + coastline)
6. Need Three.js port

---

## Iteration 3 — Combined Layers Playground (2026-01-31)

**Reference:** yale_1015869.jpg — Mediterranean portolan showing how all elements work together

**Observation:** Individual playgrounds (vellum, rhumb lines, coastline) cannot show visual coherence. To tune relative opacities and identify missing features, need to see all layers composited.

**Contribution:** Created `reference/combined-playground.html` — unified view with:

- **Dual-canvas architecture:** WebGL for vellum shader, Canvas 2D overlay for vector elements
- **Layer toggles:** Independent visibility for vellum, rhumb lines, land fill, coastline, compass roses
- **Unified controls:** Key parameters from all three playgrounds in one panel
- **Presets:** Authentic, Dense, Sparse, Dramatic

**Technical approach:**
- Vellum renders to WebGL canvas (full shader with noise-based variation)
- Overlay canvas (transparent) draws rhumb lines, land fill, coastline, compass roses
- Shared seed ensures consistent generation across layers

**Key tuning discoveries:**
- Rhumb line opacity should be lower when combined (0.45/0.25) vs isolated (0.6/0.35)
- Land fill works best with subtle green tint (#3a6a4a) at ~15% opacity
- Coastline needs to be prominent against rhumb lines — dark brown (#2a2420)

**Default combined parameters:**
```javascript
{
  // Vellum
  warmth: 0.12, edgeDark: 0.25, cloudInt: 0.12,
  // Rhumb
  primaryRoses: 2, secondaryRoses: 6,
  rhumbPrimaryOpacity: 0.45, rhumbSecondaryOpacity: 0.25,
  // Coastline
  featureScale: 2.5, displacement: 0.35, smoothing: 3, lineWidth: 1.6,
  // Land
  landOpacity: 0.15, landTint: '#3a6a4a'
}
```

**File:** `reference/combined-playground.html`

**Remaining issues:**
1. ~~Small-scale choppiness~~ **FIXED**
2. Vellum cloudiness should be beige not gray — **looks OK in combined view**
3. Only single coastline — need islands
4. ~~No rhumb lines~~ **DONE**
5. ~~Need to combine layers~~ **DONE**
6. Need Three.js port
7. City names perpendicular to coast (signature portolan feature)
8. Port flags/markers along coast

---

---

## Iteration 19 — Ink-Style Worker Markers (2026-01-31)

**Reference:** default-3.jpg — Mediterranean portolan showing ports as subtle dots, not prominent features

**Observation:** Workers were still rendering as 3D hex extrusions — bulky dark rectangular blocks that dominated the visual. Iteration 18 fixed cities but left workers untouched. The 3D blocks clashed badly with the port-style aesthetic.

**Contribution:** Replaced worker hex extrusions with flat ink-style markers:

**Visual changes:**
1. **Ink-style markers:** Small dark circles (radius 0.12) with dark outline, like ink dots on the Marauder's Map
2. **Status indication:** Marker color changes based on worker status (PALETTE.workerActive vs workerIdle)
3. **Activity decals:** Repositioned using `screenToWorld()` for consistency
4. **Breathing animation:** Still works — scales the 2D marker mesh

**Technical approach:**
- `CircleGeometry(0.12, 12)` for marker + `CircleGeometry(0.15, 12)` for outline
- `MeshBasicMaterial` (flat shading, no lighting) for ink appearance
- Removed `createHexMesh()` call, replaced with flat circles
- Added `createWorkerLabel()` for italic handwritten names (labels render but visibility needs future tuning)

**Code changes in `ZoneRenderer.ts`:**
- `renderWorker()` now creates flat circles instead of hex extrusion
- `createWorkerLabel()` new method for ink-style italic text
- `updateWorkerActivity()` repositioned to match new layout
- Status color update uses `MeshBasicMaterial` (not `MeshStandardMaterial`)

**Result:** Workers no longer visually dominate the map. They're subtle ink dots that blend with the portolan aesthetic. The transformation from "game board" to "navigation chart" is now complete for both cities and workers.

**Remaining work:**
- Improve worker label visibility (currently rendering but hard to see)
- Marauder's Map animated ink figures (true humanoid shapes, not just dots)
- Worker force simulation (wander near city, avoid collision)
- Eventually remove HexGrid.ts entirely

---

## Iteration 12 — Simplify Rhumb Lines & Remove Hex Grid (2026-01-31)

**Reference:** default-3.jpg — Mediterranean portolan with clear rhumb line network

**Discussion:** User raised conceptual question about rhumb line purpose. Historical portolan rhumb lines radiated from where mariners WERE — functional navigation, not decoration. Considered: (1) dynamic rose following camera, (2) roses anchored at cities. Deferred deeper redesign for now.

**Contributions:**

1. **Reduced compass roses:** 1 primary + 3 secondary (was 2 + 6). Lowered opacity to 0.30/0.18. Less visual clutter.

2. **Removed hex grid overlay:** The background hex outlines are gone. Vellum + rhumb lines are now the only substrate. Cities/workers float like ports on a navigation chart rather than pieces on a game board.

**Result:** The map feels more like an authentic portolan chart — open sea with navigation lines, punctuated by ports (cities). The game-board aesthetic is replaced with cartographic aesthetic.

**Filed for later:** `design-dynamic-rhumb-lines-f2a2c46d` — the question of functional vs decorative rhumb lines, city-anchored roses, camera-following primary rose.

**Remaining work:**
- Port coastlines to Three.js
- Port mountains, hatching, labels
- Revisit rhumb line design when more context exists

## Comments
**2026-01-31 21:19** — Iteration 20: Worker force simulation + wandering. Created WorkerRenderer.ts that moves workers using physics: attract to home city, repel from other workers, random wander. Workers spawn 1-2.5 units away, can drift up to 3.5 units. Click detection now uses world position. Removed hex selection ring for workers.
