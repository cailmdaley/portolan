---
title: Document nano-banana prompting patterns for portolan sprites
status: open
kind: doc
priority: 2
created-at: 2026-02-01T02:00:31.298663+01:00
---

# City Sprite Generation

Generate city plan sprites for the portolan map using `/nano-banana`. Each city gets a unique sprite that blends into the vellum background.

## Prompt Template

```
I'm creating sprites for a digital portolan map - the medieval Mediterranean
navigation charts with their warm vellum backgrounds, compass roses, and rhumb
lines. Each city on the map needs a small illustrated city plan that looks like
it was drawn by a Renaissance cartographer.

The sprite will be placed on a warm cream vellum texture (#f5eee1). The white
background will become transparent through difference matting, so the ink lines
will appear drawn directly on the parchment.

Generate a [CITY TYPE] - [BRIEF DESCRIPTION]:
- Bird's eye view with slight isometric depth
- [SPECIFIC FEATURES FOR THIS CITY TYPE]
- Hand-inked linework: sepia, red ochre, and verdigris/teal inks

IMPORTANT for compositing:
- Pure solid white #FFFFFF background (will become transparent)
- NO paper texture - the vellum layer provides that
- Edges should be incomplete and organic - [roads/water/terrain] trailing off, fading at margins
- NOT a circular frame or ornamental border

512x512 pixels. No text labels.
```

## City Types

**Port city** — harbor with docks, city walls with towers, main gate facing sea, small ships at anchor, central plaza, church spire

**Hilltop fortress** — concentric walls climbing hill, switchback roads up slopes, castle/keep at top, small town clustered at base

**River city** — split by winding river, bridges connecting halves, curved streets following riverbanks, watermills

**Island city** (Venice-like) — canals instead of streets, bridges between islands, gondolas, dense buildings at water's edge, lagoon with ships

**Walled market town** — oval walls with towers, large central market square, guild hall, main roads radiating to gates, cathedral

## Transparency Workflow

The diff-mat approach produces clean transparency:

1. **Generate on white** — Use the prompt template with "pure solid white #FFFFFF background"

2. **Edit to black** — `/nano-banana` with prompt:
   ```
   Change white background to solid pure black #000000. Keep EVERYTHING else exactly unchanged.
   ```

3. **Extract alpha** — Run the extraction script:
   ```bash
   python scripts/extract_alpha.py white.png black.png output.png
   ```

4. **Install** — Copy to `public/sprites/cities/<city-id>.png`

The math: `alpha = 1 - (white - black) / 255`, `color = black / alpha`

## Key Prompt Elements

What works:
- **Context first** — Explain portolan maps, why transparency matters
- **Specific city type** — Not just "city" but "hilltop fortress" or "river city"
- **Organic edges** — "as if the cartographer stopped drawing"
- **Explicit negatives** — "NOT a circular frame", "no ornamental border"
- **No paper texture** — The vellum layer provides texture

What to avoid:
- Circular compositions with frames
- Internal paper/parchment textures (competes with vellum)
- Perfect geometric shapes
- Text or labels

## Default Sprites

Five defaults in `public/sprites/cities/default-{1-5}.png`:

| File | Type |
|------|------|
| default-1.png | Port city |
| default-2.png | Hilltop fortress |
| default-3.png | River city |
| default-4.png | Island/Venice |
| default-5.png | Market town |

Cities without custom sprites get a deterministic default based on city ID hash.

## Generating for a Specific City

To generate a sprite for a city based on its project:

1. Read the city's README.md, CLAUDE.md, package.json
2. Synthesize what the project is about (data science? game? API?)
3. Choose a city type that evokes the project's character
4. Add project-specific details to the prompt (grid-like for structured code, winding for organic projects)
5. Run the transparency workflow
6. Save to `public/sprites/cities/<city-id>.png`

The browser will load custom sprites automatically on next refresh.
