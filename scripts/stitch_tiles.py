#!/usr/bin/env python3
"""Stitch terrain tiles using 2D MSE minimization to find optimal alignment."""

import numpy as np
from PIL import Image
from pathlib import Path
import argparse

OUTPUT_DIR = Path(__file__).parent.parent / "nanobanana-output"


def load_image(path: Path) -> np.ndarray:
    """Load image as float32 array normalized to [0,1]."""
    img = Image.open(path).convert("RGB")
    return np.array(img, dtype=np.float32) / 255.0


def save_image(arr: np.ndarray, path: Path):
    """Save float32 array [0,1] as image."""
    arr_clipped = np.clip(arr * 255, 0, 255).astype(np.uint8)
    Image.fromarray(arr_clipped).save(path)
    print(f"Saved: {path}")


def compute_mse(strip_a: np.ndarray, strip_b: np.ndarray) -> float:
    """Compute MSE between two strips, handling size mismatches."""
    # Use the minimum height if they differ
    h = min(strip_a.shape[0], strip_b.shape[0])
    return np.mean((strip_a[:h] - strip_b[:h]) ** 2)


def find_optimal_offset_2d(
    tile_a: np.ndarray,
    tile_b: np.ndarray,
    edge: str,  # "right", "left", "bottom", "top"
    overlap_range: tuple[int, int],
    vertical_range: tuple[int, int],
    strip_width: int = 64,
) -> tuple[int, int, float]:
    """
    Find optimal (overlap, vertical_offset) via 2D MSE search.

    For horizontal stitching (edge="right"):
      - overlap: how many pixels of tile_a's right edge overlap with tile_b's left edge
      - vertical_offset: how many pixels to shift tile_b down (positive) or up (negative)

    Returns: (best_overlap, best_v_offset, best_mse)
    """
    best_mse = float("inf")
    best_overlap = overlap_range[0]
    best_v_offset = 0

    results = []

    for overlap in range(overlap_range[0], overlap_range[1] + 1):
        for v_offset in range(vertical_range[0], vertical_range[1] + 1):
            if edge == "right":
                # A's right edge vs B's left edge
                strip_a = tile_a[:, -overlap : -overlap + strip_width]
                strip_b = tile_b[:, :strip_width]
            elif edge == "left":
                # A's left edge vs B's right edge
                strip_a = tile_a[:, overlap - strip_width : overlap]
                strip_b = tile_b[:, -strip_width:]
            elif edge == "bottom":
                # A's bottom edge vs B's top edge
                strip_a = tile_a[-overlap : -overlap + strip_width, :]
                strip_b = tile_b[:strip_width, :]
            elif edge == "top":
                # A's top edge vs B's bottom edge
                strip_a = tile_a[overlap - strip_width : overlap, :]
                strip_b = tile_b[-strip_width:, :]
            else:
                raise ValueError(f"Unknown edge: {edge}")

            # Apply vertical offset to strip_b
            if v_offset > 0:
                strip_b = strip_b[v_offset:]
                strip_a = strip_a[:-v_offset] if v_offset < strip_a.shape[0] else strip_a
            elif v_offset < 0:
                strip_b = strip_b[:v_offset]
                strip_a = strip_a[-v_offset:]

            if strip_a.size == 0 or strip_b.size == 0:
                continue

            mse = compute_mse(strip_a, strip_b)
            results.append((overlap, v_offset, mse))

            if mse < best_mse:
                best_mse = mse
                best_overlap = overlap
                best_v_offset = v_offset

    return best_overlap, best_v_offset, best_mse


def gradient_blend_horizontal(
    tile_a: np.ndarray,
    tile_b: np.ndarray,
    overlap: int,
    v_offset: int = 0,
) -> np.ndarray:
    """
    Blend tile_a (left) with tile_b (right) using gradient over overlap region.

    v_offset: vertical offset for tile_b (positive = shift down)
    """
    h_a, w_a = tile_a.shape[:2]
    h_b, w_b = tile_b.shape[:2]

    # Calculate output dimensions
    out_width = w_a + w_b - overlap
    out_height = max(h_a, h_b + abs(v_offset))

    # Determine vertical placement
    if v_offset >= 0:
        a_y_start = 0
        b_y_start = v_offset
    else:
        a_y_start = -v_offset
        b_y_start = 0

    # Create output canvas
    output = np.zeros((out_height, out_width, 3), dtype=np.float32)

    # Place tile_a
    output[a_y_start : a_y_start + h_a, :w_a] = tile_a

    # Create gradient for blending (horizontal)
    gradient = np.linspace(0, 1, overlap).reshape(1, -1, 1)

    # Blend region
    blend_x_start = w_a - overlap
    blend_h = min(h_a - a_y_start, h_b)  # Height of overlap region

    # Get the overlapping strips
    strip_a = output[b_y_start : b_y_start + blend_h, blend_x_start : w_a]
    strip_b = tile_b[:blend_h, :overlap]

    # Apply gradient blend
    blended = strip_a * (1 - gradient) + strip_b * gradient
    output[b_y_start : b_y_start + blend_h, blend_x_start : w_a] = blended

    # Place rest of tile_b (non-overlapping part)
    output[b_y_start : b_y_start + h_b, w_a:] = tile_b[:, overlap:]

    return output


def gradient_blend_vertical(
    tile_a: np.ndarray,  # top
    tile_b: np.ndarray,  # bottom
    overlap: int,
    h_offset: int = 0,
) -> np.ndarray:
    """
    Blend tile_a (top) with tile_b (bottom) using gradient over overlap region.

    h_offset: horizontal offset for tile_b (positive = shift right)
    """
    h_a, w_a = tile_a.shape[:2]
    h_b, w_b = tile_b.shape[:2]

    # Calculate output dimensions
    out_height = h_a + h_b - overlap
    out_width = max(w_a, w_b + abs(h_offset))

    # Determine horizontal placement
    if h_offset >= 0:
        a_x_start = 0
        b_x_start = h_offset
    else:
        a_x_start = -h_offset
        b_x_start = 0

    # Create output canvas
    output = np.zeros((out_height, out_width, 3), dtype=np.float32)

    # Place tile_a
    output[:h_a, a_x_start : a_x_start + w_a] = tile_a

    # Create gradient for blending (vertical)
    gradient = np.linspace(0, 1, overlap).reshape(-1, 1, 1)

    # Blend region
    blend_y_start = h_a - overlap
    blend_w = min(w_a - a_x_start, w_b)  # Width of overlap region

    # Get the overlapping strips
    strip_a = output[blend_y_start : h_a, b_x_start : b_x_start + blend_w]
    strip_b = tile_b[:overlap, :blend_w]

    # Apply gradient blend
    blended = strip_a * (1 - gradient) + strip_b * gradient
    output[blend_y_start : h_a, b_x_start : b_x_start + blend_w] = blended

    # Place rest of tile_b (non-overlapping part)
    output[h_a:, b_x_start : b_x_start + w_b] = tile_b[overlap:]

    return output


def stitch_west_center(
    west_path: Path,
    center_path: Path,
    output_path: Path,
    overlap_hint: int = 2048,
    search_range: int = 50,
    v_search_range: int = 30,
):
    """
    Stitch west tile to center tile with 2D optimal alignment.
    West goes on the left, center on the right.
    """
    print(f"Loading {west_path.name} and {center_path.name}...")
    west = load_image(west_path)
    center = load_image(center_path)

    print(f"West shape: {west.shape}, Center shape: {center.shape}")

    # 2D search for optimal alignment
    # For west-center: west's RIGHT edge meets center's LEFT edge
    # We need to find how much overlap and vertical offset
    print(f"\nSearching overlap [{overlap_hint - search_range}, {overlap_hint + search_range}]")
    print(f"Searching v_offset [{-v_search_range}, {v_search_range}]")

    best_overlap, best_v_offset, best_mse = find_optimal_offset_2d(
        tile_a=west,
        tile_b=center,
        edge="right",
        overlap_range=(overlap_hint - search_range, overlap_hint + search_range),
        vertical_range=(-v_search_range, v_search_range),
        strip_width=64,
    )

    print(f"\nOptimal: overlap={best_overlap}, v_offset={best_v_offset}, MSE={best_mse:.6f}")

    # Blend with optimal parameters
    print("Blending...")
    result = gradient_blend_horizontal(west, center, best_overlap, best_v_offset)

    save_image(result, output_path)

    # Also save a preview
    preview_path = output_path.with_name(output_path.stem + "_preview.png")
    preview = Image.fromarray((np.clip(result * 255, 0, 255)).astype(np.uint8))
    preview.thumbnail((1024, 1024))
    preview.save(preview_path)
    print(f"Saved preview: {preview_path}")

    return best_overlap, best_v_offset


def stitch_full_cross(
    center_path: Path,
    west_path: Path,
    east_path: Path,
    north_path: Path,
    south_path: Path,
    output_path: Path,
    overlap_hint: int = 2048,
    search_range: int = 50,
    offset_search_range: int = 30,
):
    """
    Stitch all 5 tiles (center + 4 edges) into a cross pattern.
    Uses 2D search for each joint.
    """
    print("Loading tiles...")
    center = load_image(center_path)
    west = load_image(west_path)
    east = load_image(east_path)
    north = load_image(north_path)
    south = load_image(south_path)

    print(f"Center: {center.shape}")
    print(f"West: {west.shape}, East: {east.shape}")
    print(f"North: {north.shape}, South: {south.shape}")

    # --- Horizontal strip (west-center-east) ---
    print("\n=== West-Center stitch ===")
    wc_overlap, wc_v_offset, wc_mse = find_optimal_offset_2d(
        west, center, "right",
        (overlap_hint - search_range, overlap_hint + search_range),
        (-offset_search_range, offset_search_range),
    )
    print(f"West-Center: overlap={wc_overlap}, v_offset={wc_v_offset}, MSE={wc_mse:.6f}")

    print("\n=== Center-East stitch ===")
    ce_overlap, ce_v_offset, ce_mse = find_optimal_offset_2d(
        center, east, "right",
        (overlap_hint - search_range, overlap_hint + search_range),
        (-offset_search_range, offset_search_range),
    )
    print(f"Center-East: overlap={ce_overlap}, v_offset={ce_v_offset}, MSE={ce_mse:.6f}")

    # Build horizontal strip
    print("\nBlending west-center...")
    h_strip = gradient_blend_horizontal(west, center, wc_overlap, wc_v_offset)
    print(f"After west-center: {h_strip.shape}")

    print("Blending (west-center)-east...")
    h_strip = gradient_blend_horizontal(h_strip, east, ce_overlap, ce_v_offset)
    print(f"Horizontal strip: {h_strip.shape}")

    # --- Vertical stitches ---
    # Now we need to attach north (above) and south (below) to the horizontal strip
    # The horizontal strip's center section is where north/south attach

    # Calculate where center sits in the horizontal strip
    center_x_in_strip = west.shape[1] - wc_overlap

    print("\n=== North-Center stitch ===")
    nc_overlap, nc_h_offset, nc_mse = find_optimal_offset_2d(
        north, center, "bottom",  # north's bottom meets center's top
        (overlap_hint - search_range, overlap_hint + search_range),
        (-offset_search_range, offset_search_range),
    )
    print(f"North-Center: overlap={nc_overlap}, h_offset={nc_h_offset}, MSE={nc_mse:.6f}")

    print("\n=== Center-South stitch ===")
    cs_overlap, cs_h_offset, cs_mse = find_optimal_offset_2d(
        center, south, "bottom",  # center's bottom meets south's top
        (overlap_hint - search_range, overlap_hint + search_range),
        (-offset_search_range, offset_search_range),
    )
    print(f"Center-South: overlap={cs_overlap}, h_offset={cs_h_offset}, MSE={cs_mse:.6f}")

    # Build full composite
    # This is trickier because north/south only attach to center portion
    # For now, let's do a simpler approach: just vertical strip through center

    print("\nBuilding full composite...")

    # Create vertical strip (north-center-south)
    print("Blending north-center...")
    v_strip = gradient_blend_vertical(north, center, nc_overlap, nc_h_offset)
    print(f"After north-center: {v_strip.shape}")

    print("Blending (north-center)-south...")
    v_strip = gradient_blend_vertical(v_strip, south, cs_overlap, cs_h_offset)
    print(f"Vertical strip: {v_strip.shape}")

    # Now combine horizontal and vertical strips
    # The result should be a cross shape, but let's start with just saving both
    save_image(h_strip, output_path.with_name("composite_horizontal_2d.png"))
    save_image(v_strip, output_path.with_name("composite_vertical_2d.png"))

    print("\nSaved horizontal and vertical strips.")
    print("Full cross composite requires more complex logic for the corners.")


def main():
    parser = argparse.ArgumentParser(description="Stitch terrain tiles with 2D optimal alignment")
    parser.add_argument("mode", choices=["west-center", "full", "search-only"])
    parser.add_argument("--overlap", type=int, default=2048, help="Expected overlap in pixels")
    parser.add_argument("--search", type=int, default=50, help="Search range around overlap hint")
    parser.add_argument("--v-search", type=int, default=30, help="Vertical offset search range")

    args = parser.parse_args()

    if args.mode == "west-center":
        stitch_west_center(
            west_path=OUTPUT_DIR / "tile_west_outpaint.png",
            center_path=OUTPUT_DIR / "tile_center_4k_v2.png",
            output_path=OUTPUT_DIR / "west_center_2d.png",
            overlap_hint=args.overlap,
            search_range=args.search,
            v_search_range=args.v_search,
        )
    elif args.mode == "full":
        stitch_full_cross(
            center_path=OUTPUT_DIR / "tile_center_4k_v2.png",
            west_path=OUTPUT_DIR / "tile_west_outpaint.png",
            east_path=OUTPUT_DIR / "tile_east_outpaint.png",
            north_path=OUTPUT_DIR / "tile_north_outpaint.png",
            south_path=OUTPUT_DIR / "tile_south_outpaint.png",
            output_path=OUTPUT_DIR / "composite_2d.png",
            overlap_hint=args.overlap,
            search_range=args.search,
            offset_search_range=args.v_search,
        )
    elif args.mode == "search-only":
        # Just find optimal params without saving full image
        west = load_image(OUTPUT_DIR / "tile_west_outpaint.png")
        center = load_image(OUTPUT_DIR / "tile_center_4k_v2.png")

        print("2D search for west-center alignment...")
        best_overlap, best_v_offset, best_mse = find_optimal_offset_2d(
            west, center, "right",
            (args.overlap - args.search, args.overlap + args.search),
            (-args.v_search, args.v_search),
        )
        print(f"\nOptimal: overlap={best_overlap}, v_offset={best_v_offset}, MSE={best_mse:.6f}")


if __name__ == "__main__":
    main()
