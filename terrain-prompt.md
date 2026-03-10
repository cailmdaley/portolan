# Terrain Generation Prompt Template

## Hexagon Geometry (Pointy-Top)

```
              ╱╲
         S2 ╱    ╲ S1
          ╱        ╲
        │            │
     S3 │            │ S6
        │            │
          ╲        ╱
         S4 ╲    ╱ S5
              ╲╱

Side 1: faces NE → coastline runs ~150° (NNW to SSE)
Side 2: faces NW → coastline runs ~30° (NNE to SSW)
Side 3: faces W  → coastline runs ~90° (N to S, vertical)
Side 4: faces SW → coastline runs ~30° (NNE to SSW)
Side 5: faces SE → coastline runs ~150° (NNW to SSE)
Side 6: faces E  → coastline runs ~90° (N to S, vertical)
```

## Camera Reference

- Portolan camera: 45° pitch, 45° rotation (viewing from southwest, looking northeast)
- Sunlight matches viewer: from SOUTHWEST (bottom-left of image)
- Shadows cast toward NORTHEAST (upper-right of image)

## Base Prompt (include in ALL tiles)

```
Photorealistic aerial satellite view, directly overhead top-down perspective.
High-altitude view like Google Earth imagery.

STYLE:
- Photorealistic but slightly painterly
- Fine terrain detail - individual tree canopy, rock formations, sand patterns
- Natural lighting from SOUTHWEST casting subtle shadows toward northeast
- Slight atmospheric haze over distant terrain
- Epic scale - sense of grandeur and wonder

QUALITY:
- Maximum resolution and detail
- Landscape 16:9 aspect ratio
- NO text, NO labels, NO grid, NO UI, NO borders
```

## Tile-Specific Prompts

### Side 1 (NE-facing, coastline ~150°)
```
NORTHEAST COASTLINE of a continent.

COMPOSITION:
- UPPER-RIGHT: Deep blue ocean, open water
- DIAGONAL (upper-left to lower-right): Natural coastline - rocky headlands, sandy bays,
  river mouths, peninsulas. NOT straight - organic curves.
- LOWER-LEFT: Lush terrain - temperate forests, rolling hills, rivers flowing to coast

Coastline runs diagonally ~150° (upper-left toward lower-right).
Ocean in NE, land in SW.
```

### Side 2 (NW-facing, coastline ~30°)
```
NORTHWEST COASTLINE of a continent.

COMPOSITION:
- UPPER-LEFT: Deep blue ocean, possibly colder/darker water
- DIAGONAL (upper-right to lower-left): Natural coastline - fjords, rocky shores,
  boreal forests meeting the sea. NOT straight - organic curves.
- LOWER-RIGHT: Terrain - coniferous forests, tundra transition, rivers

Coastline runs diagonally ~30° (upper-right toward lower-left).
Ocean in NW, land in SE.
```

### Side 3 (W-facing, coastline ~90° vertical)
```
WEST COASTLINE of a continent.

COMPOSITION:
- LEFT: Deep blue ocean, open water
- CENTER (vertical band): Natural coastline - cliffs, beaches, river deltas.
  NOT straight - bays, peninsulas, natural curves.
- RIGHT: Lush coastal terrain - temperate forests, hills, rivers flowing west

Coastline runs roughly vertical (north to south).
Ocean in W, land in E.
```

### Side 4 (SW-facing, coastline ~30°)
```
SOUTHWEST COASTLINE of a continent.

COMPOSITION:
- LOWER-LEFT: Deep blue ocean, warm tropical waters
- DIAGONAL (upper-right to lower-left): Natural coastline - beaches, lagoons,
  mangroves, river deltas. NOT straight - organic curves.
- UPPER-RIGHT: Terrain - savannas, subtropical forests, rivers flowing to coast

Coastline runs diagonally ~30° (upper-right toward lower-left).
Ocean in SW, land in NE.
```

### Side 5 (SE-facing, coastline ~150°)
```
SOUTHEAST COASTLINE of a continent.

COMPOSITION:
- LOWER-RIGHT: Deep blue ocean, warm waters
- DIAGONAL (upper-left to lower-right): Natural coastline - barrier islands,
  estuaries, sandy shores. NOT straight - organic curves.
- UPPER-LEFT: Terrain - coastal plains, forests, wetlands, rivers

Coastline runs diagonally ~150° (upper-left toward lower-right).
Ocean in SE, land in NW.
```

### Side 6 (E-facing, coastline ~90° vertical)
```
EAST COASTLINE of a continent.

COMPOSITION:
- RIGHT: Deep blue ocean, open water
- CENTER (vertical band): Natural coastline - beaches, dunes, river mouths.
  NOT straight - barrier islands, inlets, natural curves.
- LEFT: Terrain - coastal plains transitioning to interior, forests, rivers

Coastline runs roughly vertical (north to south).
Ocean in E, land in W.
```

### Center (generate LAST)
```
CONTINENTAL INTERIOR - no ocean, all land.
Must visually blend with all 6 surrounding coastal tiles.

BIOME DIVERSITY:
- Mountain ranges with snow caps
- Major river systems flowing outward toward coasts
- Forests (temperate, boreal, tropical depending on region)
- Plains, grasslands, steppes
- Deserts, arid regions
- Lakes, wetlands

All edges should have terrain that can connect to the coastal tiles.
```

## Generation Order

1. Side 1 (NE coast) - establish style
2. Sides 2-6 - maintain consistency via Gemini session warmth
3. Center - fill interior, reference all edges

## Tiling Notes

- Keep Gemini session warm with `--resume latest` for style consistency
- Each tile is 1376x768 (16:9)
- Coastlines should have matching "land edge" characteristics where tiles meet
- Use edge-crop references if needed for seamless transitions
