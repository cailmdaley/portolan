---
title: Document nano-banana prompting patterns for portolan sprites
status: open
created-at: 2026-02-01T02:00:31.298663+01:00
---

(document-nano-banana-prompting)=
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
- Oblique projection at ~45° from horizontal (cavalier style)
- Viewed from due south (rotation 0°), looking north
- Show both rooftops AND south-facing walls in equal proportion
- [SPECIFIC FEATURES FOR THIS CITY TYPE]
- Hand-inked linework: sepia, red ochre, and verdigris/teal inks

IMPORTANT for compositing:
- Pure solid white #FFFFFF background (will become transparent)
- NO paper texture - the vellum layer provides that
- NOT a circular frame or ornamental border
- No compass roses (we draw our own)

CRITICAL for edges: The penwork must fade away organically BEFORE reaching the edge of the image. Roads trail off into nothing, buildings become sketchy and incomplete at the margins, ink lines thin and disappear. NO hard edges or square boundaries — the illustration should float in white space with soft, trailing, incomplete edges all around. Like a vignette drawn by hand.

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

**Best approach:** Let Gemini decide the visual metaphor. Describe the project richly, then ask for a city that evokes it.

### Project-Specific Prompt Template

```
This city represents "[PROJECT NAME]" — [ONE-LINE DESCRIPTION].

[2-4 PARAGRAPHS DESCRIBING THE PROJECT]:
- What it does, what problem it solves
- Key concepts, metaphors, or themes
- The "feel" of working with it (structured? organic? contemplative? efficient?)
- Any visual metaphors that come naturally (rivers of data, woven threads, etc.)

Create a portolan-style city that evokes this project. You decide the visual metaphor — what kind of city captures its essence?

---

Technical: oblique ~45° projection, viewed from south. Sepia/red ochre/verdigris ink on pure white #FFFFFF background.

CRITICAL for edges: The penwork must fade with CLEAN LINE THINNING — roads trail off as thinner and thinner lines, buildings become sketchy outlines that simply stop. NOT watercolor washes or soft gradients (those cause transparency artifacts). Sharp ink lines that thin out and end cleanly. The illustration should float in white space with organic but crisp trailing edges.

No circular frame, no compass roses. 512x512, no text labels.
```

### Workflow

1. **Read deeply** — CLAUDE.md is a start, but read further: README, actual paper source (.tex), key documentation. The abstract and introduction often reveal the project's soul better than technical setup notes.
2. Write a rich description (let Gemini see the project's character)
3. Generate from `/tmp` to avoid Gemini CLI's `.claude` folder conflicts:
   ```bash
   cd /tmp && gemini --yolo "/generate '...'"
   ```
4. If the result doesn't capture the essence, iterate with `--resume latest -p` describing *what's missing* in terms of meaning, not visual prescriptions
5. Edit to black background: `--resume latest -p "/edit <path> 'Change white background to solid pure black #000000. Keep EVERYTHING else exactly unchanged.'"`
6. Extract alpha: `python scripts/extract_alpha.py white.png black.png public/sprites/cities/<name>.png`
7. Refresh browser — CitySpritesManager loads by city name automatically

### Examples from This Session

| City | Description Given | Result |
|------|------------------|--------|
| felt | DAG-native task tracker, fibers interlock like felt fabric | Abstract woven textile structure |
| life | Personal life in Palaiseau, France | Warm village with church, Polytechnique |
| loom | Master tapestry where fibers and infrastructure live | Weaving workshop with braided threads |
| wedding | Marseille wedding, love for the city | Marseille + countryside mill |
| email | "Inbox is a garden, not battlefield" | Postal sorting house with letter streams |
| portolan | This map app itself, meta/recursive | Cartographer's workshop drawing maps |
| euclid-github | Euclid space telescope consortium | Observatory + scriptorium, data flowing |
| pure_eb | E/B mode separation, distilling pure signal from noise, alchemical | Filtering towers, dual streams, crystalline purity |
| sp_validation | Validation toolkit, the forge where instruments are made | Industrial-scientific workshops, calibration scales |
| KineLens | Mirror reflection symmetry, velocity fields, spinning galaxies | Bilateral city, gyroscopes, reflective axis |
| cmbx | CMB × Euclid cross-correlations, epochs in dialogue | Two districts (ancient/modern) bridged, messengers |
| 2024-12_edfs_lensing | Deep field CMB lensing, archaeological excavation of ancient light | Terraced dig, radio dishes, spiraling vortex |

The key insight: **describe the project's soul, not just its function**. Let Gemini find the visual metaphor.

## Trust Gemini

Two patterns to internalize:

### Trust the visual thinking

Gemini has a circuit between text and visuals that is unparalleled. Don't over-specify the visual design — describe the *project* richly and let Gemini find the metaphor.

**Wrong:** "Draw an observatory with an armillary sphere, radial cloisters in a mandala pattern, a canal bisecting the complex..."

**Right:** "This project is about separating truth from artifact. The pure E/B decomposition separates cosmological signal from noise. The work is methodical, precise, almost monastic..."

The first approach substitutes your visual imagination for Gemini's. The second gives Gemini the *meaning* and lets it find imagery you wouldn't have thought of.

### Trust the /edit step

The black-background edit almost always works correctly. What looks like "visual noise" or "artifacts" in the extracted transparency is usually:
- Trailing roads and paths (good — organic edges)
- Spoke patterns extending outward (good — visual interest)
- Incomplete building outlines (good — vignette effect)

Don't second-guess the result and regenerate. The diff-mat math is sound; trust it.
