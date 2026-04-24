import type { City } from '../state/types'
import { escapeHtml } from './utils'
import type { DirectoryEntry } from './hud-types'

interface DirectoryListingResponse {
  type: 'directoryListing'
  cityId: string
  path: string
  entries: DirectoryEntry[]
  error?: string
}

interface CityHUDFileTreeOptions {
  list: HTMLElement
  onOpenFile: (fullPath: string) => void
}

export class CityHUDFileTree {
  private list: HTMLElement
  private onOpenFile: (fullPath: string) => void
  private currentCity: City | null = null
  private ws: WebSocket | null = null
  private directoryCache = new Map<string, DirectoryEntry[]>()
  private expandedDirs = new Set<string>()
  private loadingDirs = new Set<string>()
  private directoryErrors = new Map<string, string>()
  private inFlightDirectoryRequests = new Set<string>()

  constructor(options: CityHUDFileTreeOptions) {
    this.list = options.list
    this.onOpenFile = options.onOpenFile
    this.list.addEventListener('click', this.handleListClick)
  }

  setCurrentCity(city: City | null): void {
    this.currentCity = city
  }

  setWebSocket(ws: WebSocket | null): void {
    this.ws = ws
  }

  ensureRootListing(): void {
    if (!this.currentCity) return
    const root = this.currentCity.path
    this.expandedDirs.add(root)
    if (!this.directoryCache.has(root) && !this.loadingDirs.has(root)) {
      this.requestDirectoryListing(root)
    }
    this.render()
  }

  reset(): void {
    this.directoryCache.clear()
    this.expandedDirs.clear()
    this.loadingDirs.clear()
    this.directoryErrors.clear()
    this.inFlightDirectoryRequests.clear()
    this.list.innerHTML = ''
  }

  getRuntimeStats(): {
    directoryCacheEntries: number
    expandedDirectoryCount: number
    loadingDirectoryCount: number
    directoryErrorCount: number
    inFlightDirectoryRequestCount: number
  } {
    return {
      directoryCacheEntries: this.directoryCache.size,
      expandedDirectoryCount: this.expandedDirs.size,
      loadingDirectoryCount: this.loadingDirs.size,
      directoryErrorCount: this.directoryErrors.size,
      inFlightDirectoryRequestCount: this.inFlightDirectoryRequests.size,
    }
  }

  handleMessage(message: unknown): boolean {
    const response = message as { type?: string }
    if (response.type !== 'directoryListing') return false
    this.handleDirectoryListing(message as DirectoryListingResponse)
    return true
  }

  renderEmptySearchState(): void {
    this.render()
  }

  openDirectory(path: string): void {
    if (!this.currentCity) return

    const root = this.currentCity.path.replace(/\/$/, '')
    const target = path.replace(/\/$/, '')
    if (!(target === root || target.startsWith(`${root}/`))) return

    this.expandedDirs.add(root)
    if (!this.directoryCache.has(root) && !this.loadingDirs.has(root)) {
      this.requestDirectoryListing(root)
    }

    const segments = target.slice(root.length).replace(/^\/+/, '').split('/').filter(Boolean)
    let currentPath = root
    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`
      this.expandedDirs.add(currentPath)
      if (!this.directoryCache.has(currentPath) && !this.loadingDirs.has(currentPath)) {
        this.requestDirectoryListing(currentPath)
      }
    }

    this.render()
  }

  private handleListClick = (e: MouseEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.hud-tree-row')
    if (!row) return
    const path = row.dataset.path
    const type = row.dataset.type
    if (!path || !type) return

    if (type === 'dir') {
      this.toggleDirectory(path)
      return
    }

    this.onOpenFile(path)
  }

  private toggleDirectory(path: string): void {
    if (this.expandedDirs.has(path)) {
      this.expandedDirs.delete(path)
      this.render()
      return
    }

    this.expandedDirs.add(path)
    if (!this.directoryCache.has(path) && !this.loadingDirs.has(path)) {
      this.requestDirectoryListing(path)
    }
    this.render()
  }

  private requestDirectoryListing(path: string): void {
    if (!this.currentCity || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (this.inFlightDirectoryRequests.has(path)) return

    this.inFlightDirectoryRequests.add(path)
    this.loadingDirs.add(path)
    this.directoryErrors.delete(path)
    this.render()

    this.ws.send(JSON.stringify({
      type: 'listDirectory',
      cityId: this.currentCity.id,
      path,
    }))
  }

  private handleDirectoryListing(response: DirectoryListingResponse): void {
    if (!this.currentCity || response.cityId !== this.currentCity.id) return

    this.inFlightDirectoryRequests.delete(response.path)
    this.loadingDirs.delete(response.path)

    if (response.error) {
      this.directoryErrors.set(response.path, response.error)
    } else {
      this.directoryErrors.delete(response.path)
      this.directoryCache.set(response.path, response.entries)
    }

    this.render()
  }

  private render(): void {
    if (!this.currentCity) return

    const root = this.currentCity.path
    const rootEntries = this.directoryCache.get(root)
    const rootLoading = this.loadingDirs.has(root)

    if (!this.expandedDirs.has(root)) {
      this.list.innerHTML = '<li class="hud-file-empty">Open Files tab to browse this project.</li>'
      return
    }

    if (!rootEntries && rootLoading) {
      this.list.innerHTML = '<li class="hud-file-empty">Loading…</li>'
      return
    }

    if (!rootEntries) {
      this.list.innerHTML = '<li class="hud-file-empty">No directory listing available.</li>'
      return
    }

    let html = ''
    for (const entry of rootEntries) {
      html += this.renderTreeNode(root, entry, 0)
    }

    this.list.innerHTML = html || '<li class="hud-file-empty">No matching entries.</li>'
  }

  private renderTreeNode(parentPath: string, entry: DirectoryEntry, depth: number): string {
    const fullPath = `${parentPath.replace(/\/$/, '')}/${entry.name}`
    const isDir = entry.type === 'dir'
    const isExpanded = isDir && this.expandedDirs.has(fullPath)
    const isLoading = isDir && this.loadingDirs.has(fullPath)
    const error = this.directoryErrors.get(fullPath)
    const arrow = isDir ? (isExpanded ? '▼' : '▶') : '•'

    // A11y: aria-label names the row by its entry ("docs (directory)") so the
    // tree is navigable without the arrow glyph or padding leaking into the
    // accessible name. aria-expanded mirrors the disclosure state.
    const ariaLabel = isDir
      ? `${escapeHtml(entry.name)} (${isExpanded ? 'expanded ' : ''}directory)`
      : `${escapeHtml(entry.name)} (file)`
    const expandedAttr = isDir ? ` aria-expanded="${isExpanded}"` : ''

    let html = `
      <li class="hud-tree-row" data-path="${escapeHtml(fullPath)}" data-type="${entry.type}" style="padding-left: ${depth * 16 + 8}px" aria-label="${ariaLabel}"${expandedAttr}>
        <span class="hud-tree-arrow" aria-hidden="true">${arrow}</span>
        <span class="hud-tree-name">${escapeHtml(entry.name)}</span>
      </li>
    `

    if (!isDir || !isExpanded) {
      return html
    }

    if (isLoading) {
      return html + `
        <li class="hud-tree-status" style="padding-left: ${(depth + 1) * 16 + 8}px">…</li>
      `
    }

    if (error) {
      return html + `
        <li class="hud-tree-status error" style="padding-left: ${(depth + 1) * 16 + 8}px">couldn't read directory</li>
      `
    }

    const children = this.directoryCache.get(fullPath) || []
    if (children.length === 0) {
      return html + `
        <li class="hud-tree-status" style="padding-left: ${(depth + 1) * 16 + 8}px">empty</li>
      `
    }

    for (const child of children) {
      html += this.renderTreeNode(fullPath, child, depth + 1)
    }

    return html
  }
}
