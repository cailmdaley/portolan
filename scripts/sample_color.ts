#!/usr/bin/env npx tsx
/**
 * Sample corner pixels to detect actual background color
 */

import sharp from 'sharp'

async function sampleCorners(inputPath: string): Promise<void> {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const getPixel = (x: number, y: number) => {
    const offset = (y * info.width + x) * 4
    return {
      r: data[offset],
      g: data[offset + 1],
      b: data[offset + 2],
      hex: `#${data[offset].toString(16).padStart(2, '0')}${data[offset + 1].toString(16).padStart(2, '0')}${data[offset + 2].toString(16).padStart(2, '0')}`
    }
  }

  console.log(`Image: ${info.width}×${info.height}`)
  console.log('')
  console.log('Corner samples:')
  console.log('  Top-left (0,0):', getPixel(0, 0))
  console.log('  Top-right:', getPixel(info.width - 1, 0))
  console.log('  Bottom-left:', getPixel(0, info.height - 1))
  console.log('  Bottom-right:', getPixel(info.width - 1, info.height - 1))
  console.log('  Center-top (mid, 10):', getPixel(Math.floor(info.width / 2), 10))
}

const [,, inputPath] = process.argv
if (!inputPath) {
  console.log('Usage: npx tsx scripts/sample_color.ts <image>')
  process.exit(1)
}

sampleCorners(inputPath)
