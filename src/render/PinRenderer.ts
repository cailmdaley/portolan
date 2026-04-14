// PinRenderer.ts - World-space pins for vellum cards on the hex map.
//
// First milestone of fiber `tapestry-dissolves`: render a marker at a fixed
// world position and watch how it feels through camera zoom. Pure three.js
// geometry; the card surface layers on in a later milestone.
//
// Markers are small parchment-gold cones tipped downward to the pinned point,
// topped by a little sphere. They live directly in the scene (no parent hex
// group), so their cartesian {x, z} matches the server's LayoutStore exactly.

import {
  Group,
  Mesh,
  MeshStandardMaterial,
  ConeGeometry,
  SphereGeometry,
  Object3D,
} from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Scene } from 'three'
import type { Pin } from '../state/layoutClient'
import { PALETTE } from '../state/types'

const PIN_HEIGHT = 0.55
const PIN_RADIUS = 0.12
const HEAD_RADIUS = 0.14

function buildPinMesh(): Object3D {
  const group = new Group()

  // Shared materials within a single pin (cheap; one material per pin is fine
  // for the card counts we expect — tens, not thousands).
  const gold = new MeshStandardMaterial({
    color: PALETTE.cityHex,
    roughness: 0.6,
    metalness: 0.3,
  })

  // Cone: point down, base up. Three.js cone points +Y by default; flip.
  const cone = new Mesh(new ConeGeometry(PIN_RADIUS, PIN_HEIGHT, 12), gold)
  cone.rotation.x = Math.PI
  cone.position.y = PIN_HEIGHT / 2
  group.add(cone)

  // Head sphere on top.
  const head = new Mesh(new SphereGeometry(HEAD_RADIUS, 16, 12), gold)
  head.position.y = PIN_HEIGHT + HEAD_RADIUS * 0.6
  group.add(head)

  return group
}

interface PinEntry {
  slug: string
  group: Group
  label?: CSS2DObject
}

export class PinRenderer {
  private readonly scene: Scene
  private readonly entries = new Map<string, PinEntry>()
  private showLabels = true

  constructor(scene: Scene) {
    this.scene = scene
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
      const group = new Group()
      group.add(buildPinMesh())
      if (this.showLabels) {
        const label = this.makeLabel(pin.slug)
        group.add(label)
        entry = { slug: pin.slug, group, label }
      } else {
        entry = { slug: pin.slug, group }
      }
      this.scene.add(group)
      this.entries.set(pin.slug, entry)
    }
    entry.group.position.set(pin.x, 0, pin.z)
  }

  remove(slug: string): void {
    const entry = this.entries.get(slug)
    if (!entry) return
    this.scene.remove(entry.group)
    entry.group.traverse((obj) => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) {
          for (const m of obj.material) m.dispose()
        } else {
          obj.material.dispose()
        }
      }
    })
    this.entries.delete(slug)
  }

  clear(): void {
    for (const slug of [...this.entries.keys()]) this.remove(slug)
  }

  private makeLabel(slug: string): CSS2DObject {
    const div = document.createElement('div')
    div.className = 'pin-label'
    div.textContent = slug
    const obj = new CSS2DObject(div)
    obj.position.set(0, PIN_HEIGHT + HEAD_RADIUS * 2 + 0.15, 0)
    return obj
  }
}
