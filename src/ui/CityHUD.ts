// CityHUD.ts - Corner-anchored HUD widgets overlaying the map
// Civ-style: information lives in corners, center stays clear

import type { Activity, City, GitStatus, Session } from '../state/types'
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
  private gitDetailWidget: HTMLElement
  private fiberList: HTMLElement
  private fiberWidget: HTMLElement
  private workerWidget: HTMLElement
  private workerList: HTMLElement
  private searchInput: HTMLInputElement
  private searchClear: HTMLElement
  private searchResultsList: HTMLElement
  private currentCity: City | null = null
  private ws: WebSocket | null = null
  private fibersCallback: FibersCallback | null = null
  private ignoreNextClick = false

  // Fiber state
  private openFibers: Fiber[] = []
  private closedFibers: Fiber[] = []

  // Worker state
  private cityWorkers: Session[] = []
  private activityBySession = new Map<string, Activity[]>()

  // Stored listener refs for HMR-safe cleanup
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null

  // Callbacks
  private onViewClaims: ((city: City) => void) | null = null
  private onViewPlaygrounds: ((city: City) => void) | null = null
  private onOpenFile: ((fullPath: string, originId: string, cityPath: string) => void) | null = null
  private onFocusWorker: ((sessionId: string) => void) | null = null
  private newWorkerDialog: NewWorkerDialog | null = null

  // Search state
  private currentSearchId = 0
  private searchResults: SearchResult[] = []
  private searchQuery = ''

  constructor() {
    this.container = this.createContainer()
    this.identityWidget = this.container.querySelector('.hud-identity')!
    this.gitDetailWidget = this.container.querySelector('.hud-git-detail')!
    this.fiberList = this.container.querySelector('.hud-fiber-list')!
    this.fiberWidget = this.container.querySelector('.hud-fibers')!
    this.workerWidget = this.container.querySelector('.hud-workers')!
    this.workerList = this.container.querySelector('.hud-worker-list')!
    this.searchInput = this.container.querySelector('.hud-search-input')!
    this.searchClear = this.container.querySelector('.hud-search-clear')!
    this.searchResultsList = this.container.querySelector('.hud-search-results')!
    this.setupEventHandlers()
    this.setupSearch()
    this.setupDelegatedListeners()
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
      <div class="hud-git-detail hud-widget hud-top-right" style="display: none;">
        <h3 class="hud-git-detail-heading">Git</h3>
        <div class="hud-git-detail-content"></div>
      </div>
      <div class="hud-workers hud-widget hud-bottom-left">
        <h3 class="hud-workers-heading">Workers</h3>
        <ul class="hud-worker-list"></ul>
      </div>
      <div class="hud-fibers hud-widget hud-bottom-right">
        <h3 class="hud-fibers-heading">Fibers</h3>
        <ul class="hud-fiber-list"></ul>
        <ul class="hud-search-results" style="display: none;"></ul>
        <div class="hud-search-bar">
          <input type="text" class="hud-search-input" placeholder="Search…" />
          <button class="hud-search-clear" style="display: none;">&times;</button>
        </div>
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
        // Escape collapses search first, then hides HUD
        if (this.fiberWidget.classList.contains('searching')) {
          this.collapseSearch()
          return
        }
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

  private renderGitDetail(status?: GitStatus): void {
    if (!status?.isRepo) {
      this.gitDetailWidget.style.display = 'none'
      return
    }

    this.gitDetailWidget.style.display = ''
    const content = this.gitDetailWidget.querySelector('.hud-git-detail-content')!

    const rows: string[] = []

    // Branch + remote tracking
    rows.push(`<div class="hud-gd-row">
      <span class="hud-gd-label">branch</span>
      <span class="hud-gd-value hud-gd-branch">${escapeHtml(status.branch)}</span>
    </div>`)

    if (status.ahead > 0 || status.behind > 0) {
      const parts: string[] = []
      if (status.ahead > 0) parts.push(`<span class="hud-gd-ahead">↑${status.ahead}</span>`)
      if (status.behind > 0) parts.push(`<span class="hud-gd-behind">↓${status.behind}</span>`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">remote</span>
        <span class="hud-gd-value">${parts.join(' ')}</span>
      </div>`)
    }

    // Staged breakdown
    const staged = status.staged
    if (staged.added + staged.modified + staged.deleted > 0) {
      const parts: string[] = []
      if (staged.added > 0) parts.push(`+${staged.added}`)
      if (staged.modified > 0) parts.push(`~${staged.modified}`)
      if (staged.deleted > 0) parts.push(`-${staged.deleted}`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">staged</span>
        <span class="hud-gd-value hud-gd-staged">${parts.join(' ')}</span>
      </div>`)
    }

    // Unstaged breakdown
    const unstaged = status.unstaged
    if (unstaged.added + unstaged.modified + unstaged.deleted > 0) {
      const parts: string[] = []
      if (unstaged.added > 0) parts.push(`+${unstaged.added}`)
      if (unstaged.modified > 0) parts.push(`~${unstaged.modified}`)
      if (unstaged.deleted > 0) parts.push(`-${unstaged.deleted}`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">unstaged</span>
        <span class="hud-gd-value hud-gd-unstaged">${parts.join(' ')}</span>
      </div>`)
    }

    // Untracked
    if (status.untracked > 0) {
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">untracked</span>
        <span class="hud-gd-value hud-gd-untracked">${status.untracked} file${status.untracked !== 1 ? 's' : ''}</span>
      </div>`)
    }

    // Diff stats
    if (status.linesAdded > 0 || status.linesRemoved > 0) {
      const parts: string[] = []
      if (status.linesAdded > 0) parts.push(`<span class="hud-git-add">+${status.linesAdded}</span>`)
      if (status.linesRemoved > 0) parts.push(`<span class="hud-git-rm">−${status.linesRemoved}</span>`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">diff</span>
        <span class="hud-gd-value">${parts.join(' ')}</span>
      </div>`)
    }

    // Last commit
    if (status.lastCommitMessage) {
      const timeStr = status.lastCommitTime ? this.relativeTime(status.lastCommitTime) : ''
      const msg = status.lastCommitMessage.length > 48
        ? status.lastCommitMessage.slice(0, 48) + '…'
        : status.lastCommitMessage
      rows.push(`<div class="hud-gd-commit">
        <span class="hud-gd-commit-msg">${escapeHtml(msg)}</span>
        ${timeStr ? `<span class="hud-gd-commit-time">${timeStr}</span>` : ''}
      </div>`)
    }

    content.innerHTML = rows.join('')
  }

  private relativeTime(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
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

    // Populate git detail widget (top-right)
    this.renderGitDetail(city.gitStatus)

    // Clear state for fresh load
    this.openFibers = []
    this.closedFibers = []
    this.collapseSearch()

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

  setOnFocusWorker(callback: (sessionId: string) => void): void {
    this.onFocusWorker = callback
  }

  /** Called from main.ts whenever state updates — filters to current city's workers */
  updateWorkers(sessions: Session[], activityBySession: Map<string, Activity[]>): void {
    this.activityBySession = activityBySession
    if (!this.currentCity || !this.container.classList.contains('visible')) return

    this.cityWorkers = sessions.filter(s => s.cityId === this.currentCity!.id)
    this.renderWorkers()
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
    const expectedPrefix = `${this.currentCity?.id || ''}-${this.currentSearchId}`
    if (!searchId.startsWith(expectedPrefix)) return
    if (error) {
      console.error('Search error:', error)
      return
    }
    // Deduplicate and accumulate
    for (const r of results) {
      if (!this.searchResults.some(sr => sr.fullPath === r.fullPath)) {
        this.searchResults.push(r)
      }
    }
    // Re-render combined results
    this.renderSearchResults()
  }

  // ─── Search ───

  private setupSearch(): void {
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim()
      this.searchClear.style.display = this.searchInput.value ? 'block' : 'none'
      if (!this.searchQuery) {
        this.collapseSearch()
      }
    })

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.searchQuery) {
        this.performSearch()
      }
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.collapseSearch()
        this.searchInput.blur()
      }
    })

    this.searchInput.addEventListener('focus', () => {
      this.fiberWidget.classList.add('search-focused')
    })

    this.searchInput.addEventListener('blur', () => {
      if (!this.searchQuery) {
        this.fiberWidget.classList.remove('search-focused')
      }
    })

    this.searchClear.addEventListener('click', () => {
      this.collapseSearch()
      this.searchInput.focus()
    })
  }

  /** Event delegation for both fiber list and search results clicks */
  private setupDelegatedListeners(): void {
    this.searchResultsList.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.hud-search-item') as HTMLElement | null
      if (!item) return
      if (item.dataset.type === 'file') {
        this.openFile(item.dataset.path)
      } else if (item.dataset.type === 'fiber') {
        this.openFiber(item.dataset.fiberId)
      }
    })
  }

  private performSearch(): void {
    this.searchResults = []
    this.fiberWidget.classList.add('searching')

    this.fiberList.style.display = 'none'
    this.searchResultsList.style.display = 'block'
    this.searchResultsList.innerHTML = '<li class="hud-search-loading">Searching…</li>'

    if (this.currentCity && this.ws?.readyState === WebSocket.OPEN) {
      const searchId = `${this.currentCity.id}-${++this.currentSearchId}`

      this.ws.send(JSON.stringify({
        type: 'searchFiles',
        cityId: this.currentCity.id,
        query: this.searchQuery,
        searchId: `${searchId}-name`,
        mode: 'filename',
      }))

      if (this.currentCity.originId === 'local') {
        this.ws.send(JSON.stringify({
          type: 'searchFiles',
          cityId: this.currentCity.id,
          query: this.searchQuery,
          searchId: `${searchId}-content`,
          mode: 'content',
        }))
      }
    }

    // Render fiber matches immediately while file results stream in
    this.renderSearchResults()
  }

  private collapseSearch(): void {
    this.fiberWidget.classList.remove('searching', 'search-focused')
    this.searchResults = []
    this.searchResultsList.style.display = 'none'
    this.fiberList.style.display = ''
    this.searchInput.value = ''
    this.searchQuery = ''
    this.searchClear.style.display = 'none'
  }

  private filterFibersLocally(query: string): Fiber[] {
    const q = query.toLowerCase()
    return [...this.openFibers, ...this.closedFibers].filter(f =>
      f.title.toLowerCase().includes(q) ||
      f.kind.toLowerCase().includes(q) ||
      f.id.toLowerCase().includes(q) ||
      (f.body?.toLowerCase().includes(q) ?? false) ||
      (f.reason?.toLowerCase().includes(q) ?? false)
    )
  }

  private renderSearchResults(): void {
    const files = this.searchResults.slice(0, 15)
    const fibers = this.filterFibersLocally(this.searchQuery)

    // Still waiting for server results -- keep the loading indicator
    if (files.length === 0 && fibers.length === 0) {
      if (this.searchResultsList.querySelector('.hud-search-loading')) return
      this.searchResultsList.innerHTML = '<li class="hud-search-empty">No matches</li>'
      return
    }

    let html = ''

    // Fiber matches first (reuse renderFiberItem markup)
    for (const f of fibers.slice(0, 5)) {
      const kind = f.kind || 'task'
      html += `
        <li class="hud-search-item hud-fiber-item ${kind}" data-type="fiber" data-fiber-id="${f.id}">
          <span class="hud-fiber-status">${fiberStatusIcon(f.status)}</span>
          <span class="hud-fiber-title">${escapeHtml(f.title)}</span>
          <span class="hud-fiber-kind">${kind}</span>
        </li>`
    }

    // File matches
    for (const r of files) {
      const fileName = r.path.split('/').pop() || r.path
      const lineInfo = r.line !== undefined ? `:${r.line}` : ''
      html += `
        <li class="hud-search-item hud-fiber-item file" data-type="file" data-path="${escapeHtml(r.fullPath)}">
          <span class="hud-search-icon">&#xf15c;</span>
          <span class="hud-fiber-title mono">${escapeHtml(fileName)}${lineInfo}</span>
        </li>`
    }

    this.searchResultsList.innerHTML = html || '<li class="hud-search-empty">No matches</li>'
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

  private openFiber(fiberId: string | undefined): void {
    if (!fiberId || !this.currentCity || !this.onOpenFile) return
    const feltPath = `${this.currentCity.path}/.felt/${fiberId}.md`
    this.onOpenFile(feltPath, this.currentCity.originId, this.currentCity.path)
  }

  private openFile(fullPath: string | undefined): void {
    if (!fullPath || !this.currentCity || !this.onOpenFile) return
    this.onOpenFile(fullPath, this.currentCity.originId, this.currentCity.path)
  }

  private attachFiberListeners(): void {
    // Click fiber → open .felt/{id}.md in file viewer
    this.fiberList.querySelectorAll('.hud-fiber-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.hud-fiber-handoff')) return
        this.openFiber((item as HTMLElement).dataset.fiberId)
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

  // ─── Workers ───

  private renderWorkers(): void {
    // Hide widget entirely for dormant cities with no workers
    if (this.cityWorkers.length === 0) {
      this.workerWidget.style.display = 'none'
      return
    }

    this.workerWidget.style.display = ''
    this.workerList.innerHTML = this.cityWorkers.map(s => this.renderWorkerItem(s)).join('')
    this.attachWorkerListeners()
  }

  private renderWorkerItem(session: Session): string {
    const statusClass = session.status === 'working' ? 'working' : 'idle'
    const lastAct = this.getLastActivity(session.tmuxSession)

    return `
      <li class="hud-worker-item" data-session-id="${session.id}">
        <span class="hud-worker-dot ${statusClass}">●</span>
        <span class="hud-worker-name">${escapeHtml(session.name)}</span>
        <span class="hud-worker-activity">${lastAct}</span>
      </li>
    `
  }

  private getLastActivity(tmuxSession: string): string {
    const last = this.activityBySession.get(tmuxSession)?.[0]
    if (!last) return ''
    return escapeHtml(last.summary || last.tool)
  }

  private attachWorkerListeners(): void {
    for (const item of this.workerList.querySelectorAll<HTMLElement>('.hud-worker-item')) {
      item.addEventListener('click', () => {
        const sessionId = item.dataset.sessionId
        if (sessionId) this.onFocusWorker?.(sessionId)
      })
    }
  }

  dispose(): void {
    this.hide()
    this.container.remove()
  }
}
