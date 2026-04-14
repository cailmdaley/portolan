// PinRenderer.ts - World-space card surfaces for pinned vellum cards.
//
// Milestone of fiber `tapestry-dissolves`: each pin is a parchment card lying
// flat on the hex world, with the fiber title rendered to a canvas texture.
// Pure three.js — the card is a scene object, so orthographic zoom scales it
// naturally (Open Question 1: resolved via world-space). A small anchor disc
// marks the exact pinned point under the card.
//
// Title comes from a lookup closure (fiberTitleFor). When the lookup is empty
// at upsert time (fibers still loading), the slug is drawn as a placeholder
// and the card re-renders when refreshTitles() is called.

import {
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
} from 'three'
import type { Pin } from '../state/layoutClient'
import { PALETTE } from '../state/types'

const CARD_WIDTH = 3.2
const CARD_HEIGHT = 1.2
const CARD_Y = 0.03 // just above ground plane
const ANCHOR_Y = 0.04
const ANCHOR_RADIUS = 0.1
const TEXTURE_WIDTH = 512
const TEXTURE_HEIGHT = 192
const HOVER_LIFT = 0.25
const HOVER_SCALE = 1.18

export interface PinFiberInfo {
  title: string
  /** felt status: 'open' | 'active' | 'closed' | other. Drives status glyph. */
  status?: string
}

export interface PinRendererOptions {
  /** Look up a fiber's title + status for a slug. Return null if not yet available. */
  fiberInfoFor?: (slug: string) => PinFiberInfo | null
}

interface PinEntry {
  slug: string
  group: Group
  card: Mesh
  texture: CanvasTexture
  canvas: HTMLCanvasElement
  renderedTitle: string | null
  renderedStatus: string | null
  x: number
  z: number
}

export class PinRenderer {
  private readonly scene: Scene
  private readonly entries = new Map<string, PinEntry>()
  private readonly fiberInfoFor: (slug: string) => PinFiberInfo | null

  constructor(scene: Scene, opts: PinRendererOptions = {}) {
    this.scene = scene
    this.fiberInfoFor = opts.fiberInfoFor ?? (() => null)
  }

  /** Replace all pins with the given set (diff by slug). */
  setPins(pins: Pin[]): void {
    const nextSlugs = new Set(pins.map(p => p.slug))
    for (const slug of [...this.entries.keys()]) {
      if (!nextSlugs.has(slug)) this.remove(slug)
    }
    for (const pin of pins) this.upsert(pin)
  }

  upsert(pin: Pin): void {
    let entry = this.entries.get(pin.slug)
    if (!entry) {
      entry = this.build(pin.slug)
      this.scene.add(entry.group)
      this.entries.set(pin.slug, entry)
    }
    entry.group.position.set(pin.x, 0, pin.z)
    entry.x = pin.x
    entry.z = pin.z
    this.paintCard(entry)
  }

  /** Return the slug of the topmost pinned card under the given world point,
   *  or null. Cards are axis-aligned rectangles on the y=0 plane, so this is a
   *  simple bounds test. Last-painted wins when rectangles overlap. */
  pickAtWorld(worldX: number, worldZ: number): string | null {
    const halfW = CARD_WIDTH / 2
    const halfH = CARD_HEIGHT / 2
    let hit: string | null = null
    for (const entry of this.entries.values()) {
      const dx = worldX - entry.x
      const dz = worldZ - entry.z
      if (Math.abs(dx) <= halfW && Math.abs(dz) <= halfH) hit = entry.slug
    }
    return hit
  }

  /** Highlight a single pin: lift + gentle scale. Pass null to clear. The
   *  anchor disc stays put so the pin-point remains visible. Safe to call
   *  repeatedly with the same slug. */
  setHovered(slug: string | null): void {
    for (const entry of this.entries.values()) {
      const lifted = entry.slug === slug
      entry.card.position.y = lifted ? CARD_Y + HOVER_LIFT : CARD_Y
      const s = lifted ? HOVER_SCALE : 1
      entry.card.scale.set(s, s, 1)
    }
  }

  remove(slug: string): void {
    const entry = this.entries.get(slug)
    if (!entry) return
    this.scene.remove(entry.group)
    entry.group.traverse((obj) => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose()
        const mat = obj.material
        if (Array.isArray(mat)) for (const m of mat) m.dispose()
        else mat.dispose()
      }
    })
    entry.texture.dispose()
    this.entries.delete(slug)
  }

  clear(): void {
    for (const slug of [...this.entries.keys()]) this.remove(slug)
  }

  /** Repaint cards whose title/status has changed since the last paint.
   *  Call once the fiber list lands for the city, and whenever the HUD's
   *  fiber list is re-fetched. */
  refreshTitles(): void {
    for (const entry of this.entries.values()) {
      const info = this.fiberInfoFor(entry.slug)
      if (!info) continue
      const status = info.status ?? null
      if (info.title !== entry.renderedTitle || status !== entry.renderedStatus) {
        this.paintCard(entry)
      }
    }
  }

  private build(slug: string): PinEntry {
    const group = new Group()

    const canvas = document.createElement('canvas')
    canvas.width = TEXTURE_WIDTH
    canvas.height = TEXTURE_HEIGHT
    const texture = new CanvasTexture(canvas)
    texture.anisotropy = 4

    const cardMat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    })
    const card = new Mesh(new PlaneGeometry(CARD_WIDTH, CARD_HEIGHT), cardMat)
    card.rotation.x = -Math.PI / 2
    card.position.y = CARD_Y
    group.add(card)

    const anchor = new Mesh(
      new CircleGeometry(ANCHOR_RADIUS, 16),
      new MeshBasicMaterial({ color: PALETTE.cityHex, transparent: true, opacity: 0.9 }),
    )
    anchor.rotation.x = -Math.PI / 2
    anchor.position.y = ANCHOR_Y
    group.add(anchor)

    return {
      slug, group, card, texture, canvas,
      renderedTitle: null, renderedStatus: null, x: 0, z: 0,
    }
  }

  private paintCard(entry: PinEntry): void {
    const info = this.fiberInfoFor(entry.slug)
    const title = info?.title ?? entry.slug
    const status = info?.status ?? null
    drawCardSurface(entry.canvas, title, entry.slug, status)
    entry.texture.needsUpdate = true
    entry.renderedTitle = title
    entry.renderedStatus = status
  }
}

function statusGlyph(status: string | null): string | null {
  if (status === 'active') return '◐'
  if (status === 'closed') return '●'
  if (status === 'open') return '○'
  return null
}

function statusColor(status: string | null): string {
  // Porch Morning palette: gold for active (living work), muted for open,
  // dim for closed — echoes the HUD and tapestry conventions.
  if (status === 'active') return '#9A7B35'
  if (status === 'closed') return '#7A7368'
  return '#2E2A26'
}

function drawCardSurface(
  canvas: HTMLCanvasElement,
  title: string,
  slug: string,
  status: string | null,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)

  // Parchment fill with a slight warm gradient.
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, 'rgba(248, 240, 225, 0.97)')
  grad.addColorStop(1, 'rgba(233, 220, 198, 0.97)')
  ctx.fillStyle = grad
  roundRect(ctx, 4, 4, w - 8, h - 8, 16)
  ctx.fill()

  // Border.
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(140, 110, 80, 0.55)'
  roundRect(ctx, 4, 4, w - 8, h - 8, 16)
  ctx.stroke()

  // Status glyph in the upper-left — matches the HUD's `· ○ ◐ ●` convention so
  // pinned cards read the same as the fiber list at a glance.
  const glyph = statusGlyph(status)
  if (glyph) {
    ctx.fillStyle = statusColor(status)
    ctx.font = '600 34px "EB Garamond", Garamond, serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(glyph, 22, 16)
  }

  // Title — EB Garamond if available, generous serif fallback.
  ctx.fillStyle = '#2E2A26'
  ctx.font = '600 52px "EB Garamond", Garamond, serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const wrapped = wrapLines(ctx, title, w - 56, 2)
  const lineHeight = 58
  const totalHeight = wrapped.length * lineHeight
  let y = h / 2 - totalHeight / 2 + lineHeight / 2 - 6
  for (const line of wrapped) {
    ctx.fillText(line, w / 2, y)
    y += lineHeight
  }

  // Slug caption (small, muted) — helps identify when the title wraps to a
  // generic label.
  if (slug !== title) {
    ctx.fillStyle = '#7A7368'
    ctx.font = '500 22px "JetBrains Mono", monospace'
    ctx.textBaseline = 'bottom'
    ctx.fillText(slug, w / 2, h - 18)
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return [text]
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word
    if (ctx.measureText(trial).width <= maxWidth || !current) {
      current = trial
    } else {
      lines.push(current)
      current = word
      if (lines.length === maxLines) break
    }
  }
  if (lines.length < maxLines && current) lines.push(current)
  // Truncate last line with ellipsis if it's still too long.
  if (lines.length) {
    const last = lines[lines.length - 1]
    if (ctx.measureText(last).width > maxWidth) {
      let trimmed = last
      while (trimmed.length > 1 && ctx.measureText(trimmed + '…').width > maxWidth) {
        trimmed = trimmed.slice(0, -1)
      }
      lines[lines.length - 1] = trimmed + '…'
    }
  }
  return lines
}
