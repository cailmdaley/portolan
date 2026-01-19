#!/usr/bin/env npx tsx
/**
 * chroma_to_alpha.ts - Convert a chroma key color to transparency
 *
 * Usage: npx tsx scripts/chroma_to_alpha.ts <input> <output> [keyColor] [tolerance]
 *
 * Example: npx tsx scripts/chroma_to_alpha.ts banner-magenta.jpg public/banner.png "#FF00FF" 50
 */

import sharp from 'sharp'

interface RGB {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) throw new Error(`Invalid hex color: ${hex}`)
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  }
}

function colorDistance(c1: RGB, c2: RGB): number {
  // Euclidean distance in RGB space
  return Math.sqrt(
    Math.pow(c1.r - c2.r, 2) +
    Math.pow(c1.g - c2.g, 2) +
    Math.pow(c1.b - c2.b, 2)
  )
}

/**
 * Measure how "magenta-like" a pixel is (high R + high B, low G)
 * Returns 0-1 where 1 = pure magenta
 */
function magentaness(pixel: RGB): number {
  // Magenta = high red, high blue, low green
  // Score based on: (R + B) / 2 being high AND G being low
  const rb_avg = (pixel.r + pixel.b) / 2
  const g_deficit = 255 - pixel.g  // How far green is from max

  // Both conditions need to be true for high magentaness
  // Normalize to 0-1 range
  const rb_score = rb_avg / 255
  const g_score = g_deficit / 255

  // Geometric mean gives us "both must be high"
  return Math.sqrt(rb_score * g_score)
}

async function chromaToAlpha(
  inputPath: string,
  outputPath: string,
  keyColor: RGB,
  tolerance: number = 50,
  feather: number = 20
): Promise<void> {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const outputBuffer = Buffer.alloc(data.length)

  // Max distance for feathering (tolerance + feather range)
  const maxDist = tolerance + feather

  // For magenta key, also use magentaness metric
  const useMagentaness = keyColor.r > 200 && keyColor.b > 200 && keyColor.g < 50

  for (let i = 0; i < info.width * info.height; i++) {
    const offset = i * 4

    const pixel: RGB = {
      r: data[offset],
      g: data[offset + 1],
      b: data[offset + 2],
    }

    const dist = colorDistance(pixel, keyColor)

    let alpha: number

    if (useMagentaness) {
      // For magenta: combine distance AND magentaness metrics
      const mag = magentaness(pixel)

      // High magentaness (>0.7) = likely background, make transparent
      // Scale tolerance based on magentaness
      const effectiveTolerance = tolerance + (mag > 0.5 ? 100 * mag : 0)
      const effectiveMaxDist = effectiveTolerance + feather

      if (dist <= effectiveTolerance || mag > 0.75) {
        alpha = 0
      } else if (dist <= effectiveMaxDist) {
        alpha = (dist - effectiveTolerance) / feather
        // Also fade based on magentaness for fringe pixels
        if (mag > 0.4) {
          alpha *= Math.pow(1 - mag, 2)
        }
      } else {
        alpha = 1
        // Still reduce alpha for magenta-ish pixels that escaped distance check
        if (mag > 0.45) {
          alpha = Math.max(0, 1 - (mag - 0.45) * 1.8)
        }
      }
    } else {
      // Standard distance-based for other key colors
      if (dist <= tolerance) {
        alpha = 0
      } else if (dist <= maxDist) {
        alpha = (dist - tolerance) / feather
      } else {
        alpha = 1
      }
    }

    // Keep original color, just modify alpha
    outputBuffer[offset] = pixel.r
    outputBuffer[offset + 1] = pixel.g
    outputBuffer[offset + 2] = pixel.b
    outputBuffer[offset + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  }

  await sharp(outputBuffer, {
    raw: { width: info.width, height: info.height, channels: 4 }
  })
    .png()
    .toFile(outputPath)

  console.log(`✓ Converted ${inputPath} → ${outputPath}`)
  console.log(`  Key color: rgb(${keyColor.r}, ${keyColor.g}, ${keyColor.b})`)
  console.log(`  Tolerance: ${tolerance}, Feather: ${feather}`)
  console.log(`  Dimensions: ${info.width}×${info.height}`)
}

// CLI
const [,, inputPath, outputPath, keyColorHex = '#FF00FF', toleranceStr = '50', featherStr = '20'] = process.argv

if (!inputPath || !outputPath) {
  console.log('Usage: npx tsx scripts/chroma_to_alpha.ts <input> <output> [keyColor] [tolerance] [feather]')
  console.log('')
  console.log('Arguments:')
  console.log('  input      Input image (jpg/png)')
  console.log('  output     Output PNG with transparency')
  console.log('  keyColor   Chroma key color (default: #FF00FF magenta)')
  console.log('  tolerance  Pixels within this distance are fully transparent (default: 50)')
  console.log('  feather    Gradual fade zone beyond tolerance (default: 20)')
  process.exit(1)
}

const keyColor = hexToRgb(keyColorHex)
const tolerance = parseInt(toleranceStr, 10)
const feather = parseInt(featherStr, 10)

chromaToAlpha(inputPath, outputPath, keyColor, tolerance, feather)
  .catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
  })
