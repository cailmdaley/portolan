---
title: 3-slice banner labels with Nano Banana assets
status: closed
kind: decision
priority: 2
created-at: 2026-01-18T18:07:48.364379+01:00
closed-at: 2026-01-18T18:08:00.000000+01:00
close-reason: "Implemented 3-slice banner system using Nano Banana generated scroll asset. Banner stretches horizontally for variable text lengths while preserving curled scroll ends. Much better visual quality than procedural drawing."
---

## Decision

Use **generated image assets** (via Nano Banana) for UI elements like map labels, then composite text on top using canvas 3-slice technique.

## Why

Procedural canvas drawing has limits — bezier curves, gradients, and shadows can only get so pretty. Generated/authored assets look dramatically better and are standard practice in game dev.

## The Pattern

### 1. Generate the Asset

```bash
gemini --yolo "/generate 'Horizontal parchment scroll banner, curled ends, aged paper texture, warm cream and sepia tones. Subtle gold filigree border accents. Empty center for text overlay. Cartographic antique map style. Transparent PNG background. Landscape orientation, wide and short like a ribbon. No text.'"
```

Key prompt elements:
- Describe the shape (scroll, banner, bubble, etc.)
- Specify texture and color palette
- **"Empty center for text overlay"** — crucial
- **"No text"** — we composite text ourselves
- **"Transparent PNG background"** — for compositing

### 2. Iterate with Warm Cache

```bash
# Refine with --resume latest
gemini --yolo --resume latest -p "/generate 'same scroll but with cleaner center'"
```

### 3. Copy to Public Assets

```bash
cp nanobanana-output/your_image.png public/banner.png
```

### 4. Implement 3-Slice in Code

```typescript
// Load image once
private bannerImage: HTMLImageElement | null = null
private readonly BANNER_LEFT_SLICE = 200   // px to keep fixed
private readonly BANNER_RIGHT_SLICE = 200

private loadBannerImage(): void {
  const img = new Image()
  img.onload = () => this.bannerImage = img
  img.src = '/banner.png'
}

// In createLabel():
// Left slice (fixed)
ctx.drawImage(bannerImage,
  0, 0, leftSlice, srcH,      // source
  0, 0, leftSlice, outH)      // dest

// Middle slice (stretched to fit text)
ctx.drawImage(bannerImage,
  leftSlice, 0, middleSrcW, srcH,   // source
  leftSlice, 0, middleW, outH)       // dest (stretched)

// Right slice (fixed)
ctx.drawImage(bannerImage,
  srcW - rightSlice, 0, rightSlice, srcH,
  leftSlice + middleW, 0, rightSlice, outH)

// Then draw text centered on top
ctx.fillText(text, cx, cy)
```

### 5. Sprite Scale

The canvas dimensions are dynamic (based on text width), so sprite scale needs to account for the rough aspect ratio. For roughly square banners:

```typescript
labelSprite.scale.set(4.5, 2.0, 1)  // city labels
labelSprite.scale.set(3.0, 1.3, 1)  // worker labels (smaller)
```

## Files

- `/public/banner.png` — the scroll asset (1584×672)
- `src/render/ZoneRenderer.ts` — `createLabel()` with 3-slice logic
- `nanobanana-output/` — generated images (gitignored)

## When to Use This Pattern

- Map labels, nameplates
- Speech bubbles, tooltips
- UI panels that need to stretch
- Any decorative frame around text

## Alternatives Considered

1. **Procedural canvas drawing** — limited visual quality, lots of code
2. **Fixed-size images** — can't accommodate variable text lengths
3. **CSS/HTML overlays** — works but doesn't integrate with 3D scene
