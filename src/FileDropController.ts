// FileDropController.ts - Native drag-and-drop from outside the page (Finder,
// browser tabs, links) onto the canvas, pinning the dropped item as a non-fiber
// pin. See fiber `tapestry-dissolves` Open Q3 (`pin-any-file-type`).
//
// Two source flavors are supported today:
//   1. URL drop: text/uri-list (drag a tab or link) → pinFile({ url }).
//   2. Local file drop: drag from Finder. In a plain browser, dropped File
//      objects do NOT expose an absolute path (it's an Electron-only field), so
//      we can't directly call pinFile({ originId, path }). The drop is logged
//      and surfaced to the user; persistent storage of dropped bytes is a
//      separate decision (see open question filed by `tapestry-dissolves`).
//
// Coexists with PinDragController (HUD → canvas drag for fiber pins): that
// controller drives a synthetic ghost via Pointer events, while this one rides
// native browser drag events. They never conflict — native drag fires only when
// the source is the OS / another tab.
import { pinFile } from './state/layoutClient'
import type { Pin, PinSource } from './state/layoutClient'

interface FileDropOptions {
  canvas: HTMLCanvasElement
  screenToWorld: (x: number, y: number) => { x: number; z: number }
  getPinnedCityId: () => string | null
  onPinned: (pin: Pin) => void
}

export class FileDropController {
  private readonly opts: FileDropOptions
  private active = false

  constructor(opts: FileDropOptions) {
    this.opts = opts
    document.addEventListener('dragenter', this.onDragEnter, true)
    document.addEventListener('dragover', this.onDragOver, true)
    document.addEventListener('dragleave', this.onDragLeave, true)
    document.addEventListener('drop', this.onDrop, true)
  }

  dispose(): void {
    document.removeEventListener('dragenter', this.onDragEnter, true)
    document.removeEventListener('dragover', this.onDragOver, true)
    document.removeEventListener('dragleave', this.onDragLeave, true)
    document.removeEventListener('drop', this.onDrop, true)
    this.clearActive()
  }

  private isExternalDrag(dt: DataTransfer | null): boolean {
    if (!dt) return false
    const types = dt.types
    for (let i = 0; i < types.length; i++) {
      const t = types[i]
      if (t === 'Files' || t === 'text/uri-list' || t === 'text/x-moz-url') return true
    }
    return false
  }

  private onDragEnter = (e: DragEvent): void => {
    if (!this.isExternalDrag(e.dataTransfer)) return
    if (document.body.classList.contains('pin-dragging')) return
    e.preventDefault()
    if (!this.active) {
      this.active = true
      document.body.classList.add('pin-dropping')
    }
  }

  private onDragOver = (e: DragEvent): void => {
    if (!this.isExternalDrag(e.dataTransfer)) return
    if (document.body.classList.contains('pin-dragging')) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  private onDragLeave = (e: DragEvent): void => {
    if (e.relatedTarget) return
    this.clearActive()
  }

  private onDrop = (e: DragEvent): void => {
    if (!this.isExternalDrag(e.dataTransfer)) return
    if (document.body.classList.contains('pin-dragging')) return
    e.preventDefault()
    e.stopPropagation()
    this.clearActive()

    const cityId = this.opts.getPinnedCityId()
    if (!cityId) {
      console.warn('[file-drop] no city is open; drop ignored')
      return
    }
    if (!this.isOverCanvas(e)) {
      console.warn('[file-drop] release not over canvas')
      return
    }
    const world = this.opts.screenToWorld(e.clientX, e.clientY)
    if (!Number.isFinite(world.x) || !Number.isFinite(world.z)) {
      console.warn('[file-drop] screenToWorld returned non-finite', world)
      return
    }

    const source = extractSource(e.dataTransfer)
    if (!source) {
      const fileCount = e.dataTransfer?.files.length ?? 0
      if (fileCount > 0) {
        console.warn(
          '[file-drop] dropped local file has no addressable path. ' +
          'Plain-browser File objects do not expose an absolute path; ' +
          'see tapestry-dissolves Open Q3 for the storage decision.',
        )
      } else {
        console.warn('[file-drop] no usable source in drop dataTransfer')
      }
      return
    }
    void pinFile(cityId, { x: world.x, z: world.z }, source)
      .then(pin => this.opts.onPinned(pin))
      .catch(err => console.error('[file-drop] pinFile failed', err))
  }

  private clearActive(): void {
    if (!this.active) return
    this.active = false
    document.body.classList.remove('pin-dropping')
  }

  private isOverCanvas(e: DragEvent): boolean {
    const rect = this.opts.canvas.getBoundingClientRect()
    return (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    )
  }
}

function extractSource(dt: DataTransfer | null): PinSource | null {
  if (!dt) return null

  // Electron-style: File.path is set when the host wraps file:// drops with
  // the absolute path. Plain Chromium does not populate this, but if the host
  // ever does (Tauri, Electron shell, browser flag), use it.
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i] as File & { path?: string }
    if (typeof f.path === 'string' && f.path.startsWith('/')) {
      return { originId: 'local', path: f.path }
    }
  }

  const url = firstUrl(dt)
  if (url) {
    if (url.startsWith('file://')) {
      try {
        const u = new URL(url)
        const path = decodeURIComponent(u.pathname)
        if (path.startsWith('/')) return { originId: 'local', path }
      } catch {
        // fall through to URL pin
      }
    }
    return { url }
  }
  return null
}

function firstUrl(dt: DataTransfer): string | null {
  const uriList = dt.getData('text/uri-list')
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) return trimmed
    }
  }
  const mozUrl = dt.getData('text/x-moz-url')
  if (mozUrl) {
    const first = mozUrl.split(/\r?\n/)[0]?.trim()
    if (first) return first
  }
  const text = dt.getData('text/plain').trim()
  if (text && /^(https?|file):\/\//.test(text)) return text
  return null
}
