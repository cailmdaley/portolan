// CityHUD.ts - Corner-anchored HUD widgets overlaying the map
// Civ-style: information lives in corners, center stays clear

import type { City, GitStatus } from '../state/types'
import { escapeHtml, fiberStatusIcon } from './utils'
import type { Fiber, SearchResult } from './CityPanel'
import type { NewWorkerDialog } from './NewWorkerDialog'

interface FibersResponse {
  type: 'fibers'
  cityId: string
  open: Fiber[]
  recentlyClosed: Fiber[]
}

type FibersCallback = (response: FibersResponse) => void

export class CityHUD {
  private container: HTMLElement
  private identityWidget: HTMLElement
  private fiberList: HTMLElement
  private currentCity: City | null = null
  private ws: WebSocket | null = null
  private fibersCallback: FibersCallback | null = null
  private ignoreNextClick = false

  // Fiber state
  private openFibers: Fiber[] = []
  private closedFibers: Fiber[] = []

  // Stored listener refs for HMR-safe cleanup
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null

  // Callbacks
  private onViewClaims: ((city: City) => void) | null = null
  private onViewPlaygrounds: ((city: City) => void) | null = null
  private onOpenFile: ((fullPath: string, originId: string, cityPath: string) => void) | null = null
  private newWorkerDialog: NewWorkerDialog | null = null

  // Search state (for handleMessage compatibility)
  private currentSearchId = 0
  private searchResults: SearchResult[] = []

  constructor() {
    this.container = this.createContainer()
    this.identityWidget = this.container.querySelector('.hud-identity')!
    this.fiberList = this.container.querySelector('.hud-fiber-list')!
    this.setupEventHandlers()
    document.body.appendChild(this.container)
  }

  private createContainer(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'city-hud'
    el.innerHTML = `
      <div class="hud-identity hud-widget hud-top-left">
        <div class="hud-identity-content">
          <h2 class="hud-city-name"></h2>
          <p class="hud-city-path"></p>
          <div class="hud-git-summary"></div>
        </div>
      </div>
      <div class="hud-fibers hud-widget hud-bottom-right">
        <h3 class="hud-fibers-heading">Fibers</h3>
        <ul class="hud-fiber-list"></ul>
      </div>
    `
    return el
  }

  private setupEventHandlers(): void {
    this.clickOutsideHandler = (e: MouseEvent) => {
      if (this.ignoreNextClick) {
        this.ignoreNextClick = false
        return
      }
      if (!this.container.classList.contains('visible')) return
      const target = e.target as HTMLElement
      // Don't close if file viewer modal is open
      const fileViewer = document.querySelector('.file-viewer-modal.visible')
      if (fileViewer?.contains(target)) return
      const fileViewerBackdrop = document.querySelector('.file-viewer-backdrop.visible')
      if (fileViewerBackdrop?.contains(target)) return
      if (!this.container.contains(target)) {
        this.hide()
      }
    }

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.container.classList.contains('visible')) {
        const fileViewer = document.querySelector('.file-viewer-modal.visible')
        if (fileViewer) return
        this.hide()
      }
    }
  }

  private attachDocumentListeners(): void {
    if (this.clickOutsideHandler) {
      document.addEventListener('click', this.clickOutsideHandler)
    }
    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
  }

  private detachDocumentListeners(): void {
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler)
    }
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
    }
  }

  private renderGitSummary(status?: GitStatus): string {
    if (!status?.isRepo) return ''

    const parts: string[] = []

    // Branch name
    parts.push(`<span class="hud-git-branch">${escapeHtml(status.branch)}</span>`)

    // Change counts — compact inline
    const staged = status.staged.added + status.staged.modified + status.staged.deleted
    const unstaged = status.unstaged.modified + status.unstaged.deleted

    if (staged > 0) {
      parts.push(`<span class="hud-git-staged" title="Staged">●${staged}</span>`)
    }
    if (unstaged > 0) {
      parts.push(`<span class="hud-git-unstaged" title="Unstaged">○${unstaged}</span>`)
    }
    if (status.untracked > 0) {
      parts.push(`<span class="hud-git-untracked" title="Untracked">?${status.untracked}</span>`)
    }

    // Diff stats
    if (status.linesAdded > 0 || status.linesRemoved > 0) {
      const diffParts: string[] = []
      if (status.linesAdded > 0) diffParts.push(`<span class="hud-git-add">+${status.linesAdded}</span>`)
      if (status.linesRemoved > 0) diffParts.push(`<span class="hud-git-rm">−${status.linesRemoved}</span>`)
      parts.push(diffParts.join(' '))
    }

    return parts.join(' ')
  }

  // ─── Public API (matches CityPanel interface) ───

  show(city: City): void {
    this.currentCity = city

    // Populate identity widget
    const nameEl = this.identityWidget.querySelector('.hud-city-name')!
    const pathEl = this.identityWidget.querySelector('.hud-city-path')!
    const gitEl = this.identityWidget.querySelector('.hud-git-summary')!

    nameEl.textContent = city.name
    pathEl.textContent = city.path
    gitEl.innerHTML = this.renderGitSummary(city.gitStatus)

    // Clear fiber list for fresh load
    this.openFibers = []
    this.closedFibers = []

    // Ignore the click that triggered show
    this.ignoreNextClick = true

    this.attachDocumentListeners()
    this.container.classList.add('visible')

    // Request fibers
    this.requestFibers(city.id)
  }

  hide(): void {
    this.container.classList.remove('visible')
    this.currentCity = null
    this.detachDocumentListeners()
  }

  isVisible(): boolean {
    return this.container.classList.contains('visible')
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws
  }

  setOnViewClaims(callback: (city: City) => void): void {
    this.onViewClaims = callback
  }

  setOnViewPlaygrounds(callback: (city: City) => void): void {
    this.onViewPlaygrounds = callback
  }

  setOnOpenFile(callback: (fullPath: string, originId: string, cityPath: string) => void): void {
    this.onOpenFile = callback
  }

  setNewWorkerDialog(dialog: NewWorkerDialog): void {
    this.newWorkerDialog = dialog
  }

  handleMessage(message: unknown): boolean {
    const msg = message as { type?: string }
    if (msg.type === 'fibers') {
      const response = message as FibersResponse
      if (this.fibersCallback) {
        this.fibersCallback(response)
        this.fibersCallback = null
      }
      return true
    }
    if (msg.type === 'searchResults') {
      const response = message as { searchId: string; results: SearchResult[]; error?: string }
      this.handleSearchResults(response.searchId, response.results, response.error)
      return true
    }
    return false
  }

  handleSearchResults(searchId: string, results: SearchResult[], error?: string): void {
    // Stub for future search widget (Loop 3)
    const expectedPrefix = `${this.currentCity?.id || ''}-${this.currentSearchId}`
    if (!searchId.startsWith(expectedPrefix)) return
    if (error) {
      console.error('Search error:', error)
      return
    }
    // Accumulate for when search widget lands
    for (const r of results) {
      if (!this.searchResults.some(sr => sr.fullPath === r.fullPath)) {
        this.searchResults.push(r)
      }
    }
  }

  private requestFibers(cityId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.fiberList.innerHTML = '<li class="hud-fiber-empty">No connection</li>'
      return
    }

    this.fiberList.innerHTML = '<li class="hud-fiber-empty hud-fiber-loading">Loading…</li>'

    this.fibersCallback = (response) => {
      if (response.cityId === this.currentCity?.id) {
        this.renderFibers(response.open, response.recentlyClosed)
      }
    }

    this.ws.send(JSON.stringify({ type: 'getFibers', cityId }))
  }

  private renderFibers(open: Fiber[], closed: Fiber[]): void {
    this.openFibers = open
    this.closedFibers = closed

    const all = [...open, ...closed]
    if (all.length === 0) {
      this.fiberList.innerHTML = '<li class="hud-fiber-empty">No fibers</li>'
      return
    }

    // Show open fibers first, then recently closed (max ~6 total to keep compact)
    const visible = all.slice(0, 6)
    this.fiberList.innerHTML = visible.map(f => this.renderFiberItem(f)).join('')

    if (all.length > 6) {
      this.fiberList.innerHTML += `<li class="hud-fiber-overflow">+${all.length - 6} more</li>`
    }

    this.attachFiberListeners()
  }

  private renderFiberItem(fiber: Fiber): string {
    const kind = fiber.kind || 'task'

    return `
      <li class="hud-fiber-item ${kind}" data-fiber-id="${fiber.id}">
        <span class="hud-fiber-status">${fiberStatusIcon(fiber.status)}</span>
        <span class="hud-fiber-title">${escapeHtml(fiber.title)}</span>
        <span class="hud-fiber-kind">${kind}</span>
        <button class="hud-fiber-handoff" data-fiber-id="${fiber.id}" title="Hand off to worker">↗</button>
      </li>
    `
  }

  private attachFiberListeners(): void {
    // Click fiber → open .felt/{id}.md in file viewer
    this.fiberList.querySelectorAll('.hud-fiber-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.hud-fiber-handoff')) return
        const fiberId = (item as HTMLElement).dataset.fiberId
        if (fiberId && this.currentCity && this.onOpenFile) {
          const feltPath = `${this.currentCity.path}/.felt/${fiberId}.md`
          this.onOpenFile(feltPath, this.currentCity.originId, this.currentCity.path)
        }
      })
    })

    // Handoff button → send fiber to worker via WebSocket
    this.fiberList.querySelectorAll('.hud-fiber-handoff').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const fiberId = (btn as HTMLElement).dataset.fiberId
        if (fiberId && this.currentCity && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'handoff',
            fiberId,
            cityPath: this.currentCity.path,
          }))
        }
      })
    })
  }

  dispose(): void {
    this.hide()
    this.container.remove()
  }
}
