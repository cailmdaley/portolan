#!/usr/bin/env python3
"""Generate 4K terrain tiles using Gemini 3 Pro Image API."""

import os
import sys
import time
from pathlib import Path

from google import genai
from google.genai import types
from google.genai.errors import ServerError

# Ensure output directory exists
OUTPUT_DIR = Path(__file__).parent.parent / "nanobanana-output"
OUTPUT_DIR.mkdir(exist_ok=True)

# Base prompt for all terrain tiles
BASE_PROMPT = """Photorealistic aerial satellite view, directly overhead top-down perspective.
High-altitude view like Google Earth imagery.

STYLE:
- Photorealistic but slightly painterly
- Fine terrain detail - individual tree canopy, rock formations, sand patterns
- Natural lighting from SOUTHWEST casting subtle shadows toward northeast
- Slight atmospheric haze over distant terrain
- Epic scale - sense of grandeur and wonder

QUALITY:
- Maximum resolution and detail
- Square 1:1 aspect ratio
- NO text, NO labels, NO grid, NO UI, NO borders
"""

# Tile-specific prompts
TILE_PROMPTS = {
    "center": """CONTINENTAL INTERIOR - no ocean, all land.
Must visually work as a standalone continental terrain.

BIOME DIVERSITY:
- Mountain ranges with snow caps (upper portion)
- Major river systems flowing outward toward edges
- Forests (temperate greens, boreal darker greens)
- Plains, grasslands, steppes (golden/tan areas)
- Deserts, arid regions (sandy tan)
- Lakes, wetlands

Rich variety of terrain types across the image.""",

    "side1_ne": """NORTHEAST COASTLINE of a continent.

COMPOSITION:
- UPPER-RIGHT: Deep blue ocean, open water
- DIAGONAL (upper-left to lower-right): Natural coastline - rocky headlands, sandy bays,
  river mouths, peninsulas. NOT straight - organic curves.
- LOWER-LEFT: Lush terrain - temperate forests, rolling hills, rivers flowing to coast

Coastline runs diagonally ~150° (upper-left toward lower-right).
Ocean in NE, land in SW.""",

    "side2_nw": """NORTHWEST COASTLINE of a continent.

COMPOSITION:
- UPPER-LEFT: Deep blue ocean, possibly colder/darker water
- DIAGONAL (upper-right to lower-left): Natural coastline - fjords, rocky shores,
  boreal forests meeting the sea. NOT straight - organic curves.
- LOWER-RIGHT: Terrain - coniferous forests, tundra transition, rivers

Coastline runs diagonally ~30° (upper-right toward lower-left).
Ocean in NW, land in SE.""",

    "side3_w": """WEST COASTLINE of a continent.

COMPOSITION:
- LEFT: Deep blue ocean, open water
- CENTER (vertical band): Natural coastline - cliffs, beaches, river deltas.
  NOT straight - bays, peninsulas, natural curves.
- RIGHT: Lush coastal terrain - temperate forests, hills, rivers flowing west

Coastline runs roughly vertical (north to south).
Ocean in W, land in E.""",

    "side4_sw": """SOUTHWEST COASTLINE of a continent.

COMPOSITION:
- LOWER-LEFT: Deep blue ocean, warm tropical waters
- DIAGONAL (upper-right to lower-left): Natural coastline - beaches, lagoons,
  mangroves, river deltas. NOT straight - organic curves.
- UPPER-RIGHT: Terrain - savannas, subtropical forests, rivers flowing to coast

Coastline runs diagonally ~30° (upper-right toward lower-left).
Ocean in SW, land in NE.""",

    "side5_se": """SOUTHEAST COASTLINE of a continent.

COMPOSITION:
- LOWER-RIGHT: Deep blue ocean, warm waters
- DIAGONAL (upper-left to lower-right): Natural coastline - barrier islands,
  estuaries, sandy shores. NOT straight - organic curves.
- UPPER-LEFT: Terrain - coastal plains, forests, wetlands, rivers

Coastline runs diagonally ~150° (upper-left toward lower-right).
Ocean in SE, land in NW.""",

    "side6_e": """EAST COASTLINE of a continent.

COMPOSITION:
- RIGHT: Deep blue ocean, open water
- CENTER (vertical band): Natural coastline - beaches, dunes, river mouths.
  NOT straight - barrier islands, inlets, natural curves.
- LEFT: Terrain - coastal plains transitioning to interior, forests, rivers

Coastline runs roughly vertical (north to south).
Ocean in E, land in W.""",
}


def generate_tile(tile_name: str, resolution: str = "4K", model: str = None) -> Path:
    """Generate a single terrain tile at specified resolution."""

    prompt = BASE_PROMPT + "\n" + TILE_PROMPTS[tile_name]

    client = genai.Client()

    # Use env var or default to gemini-3-pro-image-preview for 4K
    model_name = model or os.environ.get("NANOBANANA_MODEL", "gemini-3-pro-image-preview")

    print(f"Generating {tile_name} at {resolution} with {model_name}...")

    # Build config - image_size only supported on gemini-3-pro-image-preview
    config_dict = {
        "response_modalities": ["IMAGE", "TEXT"],
    }

    # Only add image_config with size for models that support it
    if "3-pro" in model_name or "nano-banana-pro" in model_name:
        config_dict["image_config"] = types.ImageConfig(
            image_size=resolution,
            aspect_ratio="1:1",  # Square tiles
        )
    else:
        # Flash model - just request square aspect ratio
        config_dict["image_config"] = types.ImageConfig(
            aspect_ratio="1:1",
        )

    # Retry loop for overloaded model
    max_retries = 5
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(**config_dict),
            )
            break
        except ServerError as e:
            if "overloaded" in str(e).lower() and attempt < max_retries - 1:
                wait = 10 * (attempt + 1)
                print(f"Model overloaded, waiting {wait}s... (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
            else:
                raise

    # Extract and save image
    output_path = OUTPUT_DIR / f"terrain_{tile_name}_{resolution.lower()}.png"

    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.mime_type.startswith("image/"):
            with open(output_path, "wb") as f:
                f.write(part.inline_data.data)
            print(f"Saved: {output_path}")
            return output_path

    raise RuntimeError(f"No image in response for {tile_name}")


def main():
    # Default to center tile, or accept tile name as argument
    tile = sys.argv[1] if len(sys.argv) > 1 else "center"
    resolution = sys.argv[2] if len(sys.argv) > 2 else "4K"

    if tile == "all":
        for name in TILE_PROMPTS:
            generate_tile(name, resolution)
    elif tile in TILE_PROMPTS:
        generate_tile(tile, resolution)
    else:
        print(f"Unknown tile: {tile}")
        print(f"Available: {', '.join(TILE_PROMPTS.keys())}, all")
        sys.exit(1)


if __name__ == "__main__":
    main()
