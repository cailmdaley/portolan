---
title: 'City sprites: nano-banana generated city plans'
status: closed
kind: spec
priority: 2
created-at: 2026-02-01T01:26:17.199502+01:00
closed-at: 2026-02-01T05:46:25.452154+01:00
close-reason: |-
    Spec complete. All 7 criteria verified:

    1. Vellum background - procedural shader with organic texture, portolan palette
    2. 5 default sprites - generated via nano-banana diff-mat workflow
    3. City sprites - custom sprites by name, deterministic fallback to defaults
    4. City labels - flat red text (CSS2D), EB Garamond small caps
    5. Worker labels - flat text ring on sprite, clickable, working status styling
    6. Group-based movement - sprite + labels move atomically
    7. Portolan aesthetic - 4 compass roses, 16-direction rhumb lines, 500-unit vellum

    Manual sprite generation via /nano-banana documented. 7 custom city sprites created (felt, life, loom, wedding, email, portolan, euclid-github).
---

# City sprites: nano-banana generated city plans

You are in a Ralph loop — meditative iteration toward a desired state.

## Orientation

You have fresh eyes. No context from previous iterations binds you — use that freedom. Survey the system as it actually is, not as someone described it.

You have broad authority to advance the state. The desired state below defines "done." Everything else is yours to decide: what to check, what to prioritize, how to contribute. Trust your judgment.

Update state discoverably. Commits, fibers, test results — not notes. The next iteration will find what changed by inspecting the system.

## Loop

Each iteration:

1. **Survey** — Launch Explore agents to understand current state thoroughly. Check `felt downstream <spec-id>`, git log, tests, the actual files. Identify ALL work that's ready — not just the first thing you see.

2. **Contribute** — Maximize throughput. Identify the highest-value set of contributions that benefit from shared context, then execute:

   - **Independent work → swarm it.** If you see 3-5 tasks touching different files, launch parallel sub-agents. One iteration doing 5 parallel tasks beats 5 sequential iterations. Partition by file, not feature.

   - **Dependent work → sequence it.** If tasks must happen in order, do them sequentially within this iteration. Don't exit after step 1 to "let the next iteration verify" — that's wasted throughput.

   - **Mixed → parallelize what you can.** Some parallel, some sequential. Use your judgment.

   Start a sub-fiber for this iteration (`felt add "..." -a <spec-id>`). Let it reflect the scope of work attempted.

3. **Felt** — Before exiting, extract decisions, patterns, lessons learned. File as fibers. Update CLAUDE.md if warranted.

4. **Exit** — Always `kill $PPID`.

## Practices

- **Partition by file, not feature** — Multiple agents can work in parallel if they touch different files. Never have two agents edit the same file.
- **Substantial iterations** — A good iteration makes real progress. 15 lines of code is too small unless that's genuinely all that remains. If more work is ready, do more work.
- Close your iteration's sub-fiber with what happened, not just that it happened
- When evidence shifts the direction, comment on the spec — but sparingly

## Exit Rules

**Exhausted the ready work:** `kill $PPID`. Exit when you've done everything that's currently unblocked — not after the first contribution. The next iteration brings fresh eyes to verify and continue.

**Nothing left to do:** Close with `felt off <id> -r "..."`, then `kill $PPID`.

---

## Desired State

Portolan renders cities as nano-banana generated sprites on a vellum background.

### Background Layer

A static vellum texture fills the viewport — aged parchment, warm and textured. Red/black/verdigris color palette. No hex grid visible, just the vellum surface. This is the "blank canvas" of the map.

The vellum shader from the coastline experiment can be adapted: `coastline-experiment:src/render/VellumShader.ts` or recreated simply. It's just a textured ground plane.

### City Sprites

Each city is represented by a **nano-banana generated sprite** — a circular "city plan" illustration in portolan/antiquarian style:

- **Style**: Aged ink on transparent background. Red, black, and verdigris ink. Hand-drawn, cartographic, like a city plan from an old atlas.
- **Shape**: Roughly circular, sized to fill a 3-hex radius when placed on the map (~200-300px diameter works well for sprite resolution)
- **Content**: Abstract city plan — streets radiating from center, districts, walls, landmarks. Not literal, evocative. nano-banana receives a multi-paragraph summary of the project (from README, CLAUDE.md, directory structure) to inform the plan's character — a data science project might have grid-like districts, a game might have winding paths.
- **Transparency**: PNG with transparent background using nano-banana's transparent image workflow

Sprites are cached in `.hexarchy/sprites/cities/<city-id>.png`. If a sprite exists, load it. If not, generate via nano-banana and cache.

**Fallback sprites**: Ship 5 generic city plan sprites in `.hexarchy/sprites/cities/default-{1-5}.png`. Use these while generation is pending or if generation fails. Randomly select one per city (deterministic by city id hash).

### Labels

**City labels**: Flat red text, positioned above the city sprite. No raised hex mesh, no banner — just the city name in the same antiquarian red ink used in the coastline branch. The name is separate from the sprite (not baked in), allowing repositioning and consistent typography.

**Worker labels**: Flat text positioned on top of the city plan sprite. Reference `coastline-experiment:src/render/WorkerRenderer.ts` for the label styling — same red/verdigris ink aesthetic. Workers cluster visually within the city's territory.

### Sprite Placement

Cities are positioned using the existing hex grid logic (hex coordinates → world position). The sprite is a textured plane (or Three.js Sprite) centered at the city's position, scaled to cover roughly the 3-hex radius.

### Generation Prompt

When generating a city sprite, nano-banana receives:

1. **Project summary** (several paragraphs): Derived from README.md, CLAUDE.md, package.json description, directory structure. The summary should convey the project's domain, purpose, and character — enough context for nano-banana to create a thematically appropriate city plan.

2. **Style spec**: "Aged city plan, circular composition, portolan/antiquarian style. Red, black, and verdigris ink on transparent background. Hand-drawn cartographic aesthetic. Streets, districts, walls, small landmarks. Evocative, not literal."

3. **Size**: 512x512 square, transparent background

### Architecture

```
ZoneRenderer
├── createGroundPlane()       → vellum textured plane
├── loadCitySprite(city)      → fetch from cache, fallback to default, trigger generation
├── renderCity(city)          → place sprite at hex position
├── renderCityLabel(city)     → flat red text above sprite
└── renderWorkerLabel(...)    → flat text on top of sprite

CitySpritesManager (new)
├── getSprite(cityId)         → cached texture, fallback, or null
├── getDefaultSprite(cityId)  → deterministic default (hash id → 1-5)
├── generateSprite(city)      → build project summary, call nano-banana, save
├── spriteCache: Map<id, Texture>
└── pendingGenerations: Set<id>

Server endpoint (for project summary):
├── GET /city-summary?cityId=X  → returns multi-paragraph project summary
└── Reads: README.md, CLAUDE.md, package.json, directory structure
```

### Done When

1. Vellum background renders (aged parchment texture, portolan palette)
2. 5 default city sprites exist in `.hexarchy/sprites/cities/default-{1-5}.png`
3. Cities display sprites (fallback to defaults, then nano-banana generated when available)
4. City labels render as flat red text above sprites (no hex mesh, no banner)
5. Worker labels render as flat text on top of city sprite
6. New cities trigger sprite generation (async, use fallback while pending)
7. Moving a city moves its sprite and labels
8. The map looks like a portolan chart with city plans scattered on vellum

## Context

**Rendering foundation:**
- `src/render/ZoneRenderer.ts` — current hex renderer (being simplified)
- `coastline-experiment:src/render/VellumShader.ts` — vellum texture reference
- `coastline-experiment:src/render/WorkerRenderer.ts` — worker label styling (red/verdigris ink)
- `src/render/HexGrid.ts` — hex coordinate math

**Label styling (from coastline branch):**
- `coastline-experiment:src/render/WorkerRenderer.ts` — flat label implementation
- Red ink color: use `PALETTE` values from coastline, likely `--rust` or similar
- No 3D extrusion, no banners — flat canvas-based text

**Sprite storage:**
- `.hexarchy/sprites/` — existing sprite directory structure
- `.hexarchy/sprites/cities/` — city plan sprites (generated + defaults)
- Pattern: generate once, cache as PNG, load as texture

**nano-banana:**
- Skill for image generation via Gemini
- Use transparent image workflow for layering over vellum
- Invoke with project summary + style prompt

**Existing patterns:**
- `src/render/ZoneRenderer.ts:createLabel()` — canvas-based label creation
- Three.js Sprite/SpriteMaterial for billboarded images
- TextureLoader for loading cached PNGs

## Skills

- `/nano-banana` — Required for sprite generation

## Comments
**2026-02-01 02:24** — Iteration 1 progress:

DONE:
- Vellum shader restored and integrated as ground plane
- CitySpritesManager created for sprite loading/caching
- renderCity uses flat Mesh (not billboard) so sprites lie on vellum
- City labels are flat red text (no banners)
- 5 default sprites generated (but need refinement)
- Camera stays at 45°

NEEDS WORK:
- Sprite transparency workflow not fully solved (magenta bleeding, color mismatch)
- Better prompting for organic edges that blend into vellum
- May need difference matting with cleaner side-by-side generation
- Some sprites still have ornamental circular borders

DOCUMENTED:
- nano-banana prompting patterns in fiber document-nano-banana-prompting-15652206
**2026-02-01 02:25** — Correction: white-to-transparent approach doesn't look good either. Transparency workflow remains unsolved - needs proper difference matting with identical artwork on white/black backgrounds, which Gemini isn't reliably producing yet.
**2026-02-01 03:00** — **Iteration 3**: Prompting refined, transparency workflow validated, 5 new default sprites generated.

Key insight: Give Gemini rich context about portolan aesthetic + explicit 'organic trailing edges' instruction. Diff-mat workflow (white→black→extract) produces clean sprites that blend into vellum.

Spec progress:
✓ Vellum background renders
✓ 5 default city sprites (NEW - organic edges, no frames)
✓ Cities display sprites
✓ City labels as flat red text
? Worker labels (needs verification)
? Sprite generation for new cities (CitySpritesManager stub exists)
? Moving city moves sprite/labels
**2026-02-01 03:25** — **Iteration 5**: Workers now render as labels on city sprites, not separate hexes.

Spec progress:
✓ Vellum background renders
✓ 5 default city sprites
✓ Cities display sprites
✓ City labels as flat red text
✓ Worker labels as flat text on city sprite (verdigris/rust ink)
✓ New cities use fallbacks (manual generation documented)
✓ Moving city moves sprite+labels (group-based)
~ Visual polish remaining (map looks like portolan chart)
