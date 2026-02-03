// CityPanel.ts - DOM overlay for city details and fibers
// Unified search + Files/Fibers tabs

import type { City, GitStatus, RecentFile } from '../state/types'
import { escapeHtml, formatTimeAgo } from './utils'
import type { NewWorkerDialog } from './NewWorkerDialog'

export interface Fiber {
  id: string
  title: string
  status: string
  kind: string
  priority: number
  createdAt: string
  body?: string
  reason?: string
}

export interface SearchResult {
  path: string
  fullPath: string
  line?: number
  match?: string
}

export interface RecentAnnotatedFile {
  filePath: string
  originId: string
  annotationCount: number
  mostRecentAt: number
}

// Unified search result types
type UnifiedResult =
  | { type: 'file'; data: SearchResult }
  | { type: 'fiber'; data: Fiber }

interface FibersResponse {
  type: 'fibers'
  cityId: string
  open: Fiber[]
  recentlyClosed: Fiber[]
}

type FibersCallback = (response: FibersResponse) => void
type ActiveTab = 'files' | 'fibers'

export class CityPanel {
  private panel: HTMLElement
  private closeBtn: HTMLElement
  private resizeHandle: HTMLElement
  private cityName: HTMLElement
  private cityPath: HTMLElement
  private gitStatusEl: HTMLElement
  private newWorkerBtn: HTMLElement
  private viewClaimsBtn: HTMLElement
  private viewPlaygroundsBtn: HTMLElement
  // Unified search
  private searchInput: HTMLInputElement
  private searchClear: HTMLElement
  // Tab bar
  private filesTab: HTMLElement
  private fibersTab: HTMLElement
  // Tab content containers
  private tabContent: HTMLElement
  private searchResultsContainer: HTMLElement
  // Files tab content
  private recentAnnotationsList: HTMLElement
  private recentFilesList: HTMLElement
  // Fibers tab content
  private openFibersList: HTMLElement
  private closedFibersList: HTMLElement

  private currentCity: City | null = null
  private ws: WebSocket | null = null
  private fibersCallback: FibersCallback | null = null
  private ignoreNextClick = false
  private isResizing = false
  private minWidth = 280
  private maxWidth = 600

  // Stored listener refs for HMR-safe cleanup
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private resizeMoveHandler: ((e: MouseEvent) => void) | null = null
  private resizeUpHandler: (() => void) | null = null

  // State
  private openFibers: Fiber[] = []
  private closedFibers: Fiber[] = []
  private searchQuery = ''
  private searchResults: UnifiedResult[] = []
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private currentSearchId = 0

  // Callbacks
  private onViewClaims: ((city: City) => void) | null = null
  private onViewPlaygrounds: ((city: City) => void) | null = null
  private onOpenFile: ((fullPath: string, originId: string, cityPath: string) => void) | null = null
  private newWorkerDialog: NewWorkerDialog | null = null

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.resizeHandle = this.panel.querySelector('.resize-handle')!
    this.cityName = this.panel.querySelector('.city-name')!
    this.cityPath = this.panel.querySelector('.city-path')!
    this.gitStatusEl = this.panel.querySelector('.git-status')!
    this.newWorkerBtn = this.panel.querySelector('.new-worker-btn')!
    this.viewClaimsBtn = this.panel.querySelector('.view-claims-btn')!
    this.viewPlaygroundsBtn = this.panel.querySelector('.view-playgrounds-btn')!
    this.searchInput = this.panel.querySelector('.unified-search-input')!
    this.searchClear = this.panel.querySelector('.unified-search-clear')!
    this.filesTab = this.panel.querySelector('.tab-files')!
    this.fibersTab = this.panel.querySelector('.tab-fibers')!
    this.tabContent = this.panel.querySelector('.tab-content')!
    this.searchResultsContainer = this.panel.querySelector('.search-results-container')!
    this.recentAnnotationsList = this.panel.querySelector('.recent-annotations-list')!
    this.recentFilesList = this.panel.querySelector('.recent-files-list')!
    this.openFibersList = this.panel.querySelector('.open-fibers')!
    this.closedFibersList = this.panel.querySelector('.closed-fibers')!

    this.setupEventListeners()
    this.setupResizeHandling()
    this.setupUnifiedSearch()
    this.setupTabs()
    document.body.appendChild(this.panel)
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.id = 'city-panel'
    panel.className = 'panel'
    panel.innerHTML = `
      <div class="resize-handle"></div>
      <button class="close-btn">&times;</button>
      <h2 class="city-name"></h2>
      <p class="city-path"></p>
      <div class="git-status"></div>
      <button class="new-worker-btn">+ New Worker</button>
      <button class="view-claims-btn" style="display: none;">View Claims</button>
      <button class="view-playgrounds-btn" style="display: none;">View Playgrounds</button>

      <!-- Unified Search -->
      <div class="unified-search-container">
        <input type="text" class="unified-search-input" placeholder="Search files & fibers…" />
        <button class="unified-search-clear" aria-label="Clear search">&times;</button>
      </div>

      <!-- Tab Bar -->
      <div class="tab-bar">
        <button class="tab tab-files active">Files</button>
        <button class="tab tab-fibers">Fibers</button>
      </div>

      <!-- Search Results (shown when searching) -->
      <div class="search-results-container" style="display: none;">
        <ul class="search-results-list"></ul>
      </div>

      <!-- Tab Content (shown when not searching) -->
      <div class="tab-content">
        <!-- Files Tab -->
        <div class="files-tab-content tab-pane active">
          <section class="recent-annotations">
            <h3>Annotated</h3>
            <ul class="recent-annotations-list"></ul>
          </section>
          <section class="recent-files">
            <h3>Recently Edited</h3>
            <ul class="recent-files-list"></ul>
          </section>
        </div>

        <!-- Fibers Tab -->
        <div class="fibers-tab-content tab-pane">
          <section class="fibers open-fibers-section">
            <h3>Open</h3>
            <ul class="fiber-list open-fibers"></ul>
          </section>
          <section class="fibers closed-fibers-section">
            <h3>Recently Closed</h3>
            <ul class="fiber-list closed-fibers"></ul>
          </section>
        </div>
      </div>
    `
    return panel
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.hide())

    this.newWorkerBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.requestNewWorker()
    })

    this.viewClaimsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.currentCity && this.onViewClaims) {
        this.onViewClaims(this.currentCity)
      }
    })

    this.viewPlaygroundsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.currentCity && this.onViewPlaygrounds) {
        this.onViewPlaygrounds(this.currentCity)
      }
    })

    // Define handlers (attached/detached dynamically to avoid HMR stacking)
    this.clickOutsideHandler = (e: MouseEvent) => {
      if (this.ignoreNextClick) {
        this.ignoreNextClick = false
        return
      }
      if (this.panel.classList.contains('visible')) {
        const target = e.target as HTMLElement
        // Don't close if file viewer modal is open and click is inside it
        const fileViewer = document.querySelector('.file-viewer-modal.visible')
        if (fileViewer?.contains(target)) return
        const fileViewerBackdrop = document.querySelector('.file-viewer-backdrop.visible')
        if (fileViewerBackdrop?.contains(target)) return
        if (!this.panel.contains(target)) {
          this.hide()
        }
      }
    }

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.panel.classList.contains('visible')) {
        // Don't close if file viewer modal is open - it handles its own Escape
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

  private setupResizeHandling(): void {
    // Store handlers for cleanup
    this.resizeMoveHandler = (e: MouseEvent) => {
      if (!this.isResizing) return
      const newWidth = window.innerWidth - e.clientX
      const clampedWidth = Math.min(this.maxWidth, Math.max(this.minWidth, newWidth))
      this.panel.style.width = `${clampedWidth}px`
    }

    this.resizeUpHandler = () => {
      if (this.isResizing) {
        this.isResizing = false
        this.resizeHandle.classList.remove('dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        this.detachResizeListeners()
      }
    }

    this.resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.isResizing = true
      this.resizeHandle.classList.add('dragging')
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
      this.attachResizeListeners()
    })
  }

  private attachResizeListeners(): void {
    if (this.resizeMoveHandler) {
      document.addEventListener('mousemove', this.resizeMoveHandler)
    }
    if (this.resizeUpHandler) {
      document.addEventListener('mouseup', this.resizeUpHandler)
    }
  }

  private detachResizeListeners(): void {
    if (this.resizeMoveHandler) {
      document.removeEventListener('mousemove', this.resizeMoveHandler)
    }
    if (this.resizeUpHandler) {
      document.removeEventListener('mouseup', this.resizeUpHandler)
    }
  }

  private setupUnifiedSearch(): void {
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim()
      this.updateSearchClearVisibility()
      this.debounceSearch()
    })

    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = ''
      this.searchQuery = ''
      this.searchResults = []
      this.updateSearchClearVisibility()
      this.showTabContent()
      this.searchInput.focus()
    })

    this.updateSearchClearVisibility()
  }

  private setupTabs(): void {
    this.filesTab.addEventListener('click', () => this.setActiveTab('files'))
    this.fibersTab.addEventListener('click', () => this.setActiveTab('fibers'))
  }

  private setActiveTab(tab: ActiveTab): void {
    // Update tab button states
    this.filesTab.classList.toggle('active', tab === 'files')
    this.fibersTab.classList.toggle('active', tab === 'fibers')

    // Update pane visibility
    const filesPane = this.panel.querySelector('.files-tab-content')!
    const fibersPane = this.panel.querySelector('.fibers-tab-content')!
    filesPane.classList.toggle('active', tab === 'files')
    fibersPane.classList.toggle('active', tab === 'fibers')
  }

  private updateSearchClearVisibility(): void {
    this.searchClear.style.display = this.searchInput.value ? 'block' : 'none'
  }

  private debounceSearch(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer)
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.performUnifiedSearch()
    }, 150)
  }

  private performUnifiedSearch(): void {
    const query = this.searchQuery

    if (!query) {
      this.searchResults = []
      this.showTabContent()
      return
    }

    // Show search results view
    this.showSearchResults()

    // Search files (both name and content)
    this.searchFilesUnified(query)

    // Also filter fibers locally
    const matchingFibers = this.filterFibersLocally(query)
    this.renderUnifiedResults([], matchingFibers)
  }

  private searchFilesUnified(query: string): void {
    if (!this.currentCity || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    const searchId = `${this.currentCity.id}-${++this.currentSearchId}`
    const isRemote = this.currentCity.originId !== 'local'

    // Always search by filename
    this.ws.send(JSON.stringify({
      type: 'searchFiles',
      cityId: this.currentCity.id,
      query,
      searchId: `${searchId}-name`,
      mode: 'filename',
    }))

    // Only search content for local cities (remote content search is too slow over SSH)
    if (!isRemote) {
      this.ws.send(JSON.stringify({
        type: 'searchFiles',
        cityId: this.currentCity.id,
        query,
        searchId: `${searchId}-content`,
        mode: 'content',
      }))
    }
  }

  private filterFibersLocally(query: string): Fiber[] {
    const q = query.toLowerCase()
    const matchesFiber = (f: Fiber): boolean => {
      return (
        f.title.toLowerCase().includes(q) ||
        f.kind.toLowerCase().includes(q) ||
        f.id.toLowerCase().includes(q) ||
        (f.body?.toLowerCase().includes(q) ?? false) ||
        (f.reason?.toLowerCase().includes(q) ?? false)
      )
    }

    return [...this.openFibers, ...this.closedFibers].filter(matchesFiber)
  }

  handleSearchResults(searchId: string, results: SearchResult[], error?: string): void {
    // Ignore stale results
    if (!searchId.startsWith(this.currentCity?.id || '')) {
      return
    }

    if (error) {
      console.error('Search error:', error)
      return
    }

    // Merge file results with current fiber results
    const fileResults: UnifiedResult[] = results.map(r => ({ type: 'file' as const, data: r }))
    const fiberResults = this.filterFibersLocally(this.searchQuery)

    // Deduplicate file results by fullPath
    const seenPaths = new Set<string>()
    const existingFileResults = this.searchResults.filter(r => r.type === 'file')
    for (const r of existingFileResults) {
      if (r.type === 'file') seenPaths.add(r.data.fullPath)
    }

    const newFileResults = fileResults.filter(r => {
      if (r.type === 'file' && !seenPaths.has(r.data.fullPath)) {
        seenPaths.add(r.data.fullPath)
        return true
      }
      return false
    })

    // Combine and re-render
    const allFileResults = [...existingFileResults, ...newFileResults]
    this.renderUnifiedResults(
      allFileResults.map(r => r.type === 'file' ? r.data : null).filter(Boolean) as SearchResult[],
      fiberResults
    )
  }

  private renderUnifiedResults(files: SearchResult[], fibers: Fiber[]): void {
    const resultsList = this.panel.querySelector('.search-results-list')!

    if (files.length === 0 && fibers.length === 0) {
      resultsList.innerHTML = '<li class="empty">No matches</li>'
      return
    }

    // Render files first, then fibers
    const fileHtml = files.slice(0, 20).map(r => this.renderFileResult(r)).join('')
    const fiberHtml = fibers.slice(0, 10).map(f => this.renderFiberResult(f)).join('')

    resultsList.innerHTML = fileHtml + fiberHtml
    this.attachSearchResultListeners()
  }

  private renderFileResult(result: SearchResult): string {
    const fileName = result.path.split('/').pop() || result.path
    const dir = result.path.includes('/') ? result.path.slice(0, result.path.lastIndexOf('/')) : ''

    if (result.line !== undefined && result.match !== undefined) {
      return `
        <li class="search-result file-result" data-type="file" data-path="${escapeHtml(result.fullPath)}">
          <span class="result-icon">📄</span>
          <span class="file-name">${escapeHtml(fileName)}</span>
          <span class="file-line">:${result.line}</span>
          <span class="file-dir">${escapeHtml(dir)}</span>
          <span class="file-match">${escapeHtml(result.match)}</span>
        </li>
      `
    } else {
      return `
        <li class="search-result file-result" data-type="file" data-path="${escapeHtml(result.fullPath)}">
          <span class="result-icon">📄</span>
          <span class="file-name">${escapeHtml(fileName)}</span>
          <span class="file-dir">${escapeHtml(dir)}</span>
        </li>
      `
    }
  }

  private renderFiberResult(fiber: Fiber): string {
    const statusIcon = fiber.status === 'active' ? '◐' : fiber.status === 'closed' ? '●' : '○'
    const kindClass = fiber.kind || 'task'

    return `
      <li class="search-result fiber-result ${kindClass}" data-type="fiber" data-fiber-id="${fiber.id}">
        <span class="result-icon fiber-status">${statusIcon}</span>
        <span class="fiber-title">${escapeHtml(fiber.title)}</span>
        <span class="fiber-kind">${fiber.kind || 'task'}</span>
      </li>
    `
  }

  private attachSearchResultListeners(): void {
    this.panel.querySelectorAll('.search-result').forEach(item => {
      item.addEventListener('click', () => {
        const el = item as HTMLElement
        const type = el.dataset.type

        if (type === 'file') {
          const fullPath = el.dataset.path
          if (fullPath && this.currentCity && this.onOpenFile) {
            this.onOpenFile(fullPath, this.currentCity.originId, this.currentCity.path)
          }
        } else if (type === 'fiber') {
          const fiberId = el.dataset.fiberId
          if (fiberId && this.currentCity && this.onOpenFile) {
            // Open the fiber's markdown file
            const feltPath = `${this.currentCity.path}/.felt/${fiberId}.md`
            this.onOpenFile(feltPath, this.currentCity.originId, this.currentCity.path)
          }
        }
      })
    })
  }

  private showSearchResults(): void {
    this.searchResultsContainer.style.display = 'block'
    this.tabContent.style.display = 'none'
  }

  private showTabContent(): void {
    this.searchResultsContainer.style.display = 'none'
    this.tabContent.style.display = 'block'
  }

  private async fetchRecentAnnotations(): Promise<void> {
    if (!this.currentCity) return

    try {
      const response = await fetch(
        `http://${window.location.hostname}:4004/recent-annotations?originId=${encodeURIComponent(this.currentCity.originId)}&limit=3`
      )
      if (!response.ok) {
        this.recentAnnotationsList.innerHTML = '<li class="empty">Failed to load</li>'
        return
      }

      const data = await response.json()
      const files: RecentAnnotatedFile[] = data.files || []

      if (files.length === 0) {
        this.recentAnnotationsList.innerHTML = '<li class="empty">No annotated files</li>'
        return
      }

      this.recentAnnotationsList.innerHTML = files.map(f => this.renderRecentAnnotation(f)).join('')
      this.attachRecentAnnotationListeners()
    } catch (error) {
      console.error('Failed to fetch recent annotations:', error)
      this.recentAnnotationsList.innerHTML = '<li class="empty">Failed to load</li>'
    }
  }

  private renderRecentAnnotation(file: RecentAnnotatedFile): string {
    const fileName = file.filePath.split('/').pop() || file.filePath
    const dir = file.filePath.includes('/')
      ? file.filePath.slice(0, file.filePath.lastIndexOf('/'))
      : ''
    const timeAgo = formatTimeAgo(file.mostRecentAt)
    // Show historical entries (annotations cleared) with dimmed styling
    const isHistory = file.annotationCount === 0
    const countClass = isHistory ? 'annotation-count history' : 'annotation-count'
    const countDisplay = isHistory ? '—' : file.annotationCount.toString()

    return `
      <li class="recent-annotation-item${isHistory ? ' history' : ''}" data-path="${escapeHtml(file.filePath)}" data-origin="${escapeHtml(file.originId)}">
        <span class="file-name">${escapeHtml(fileName)}</span>
        <span class="${countClass}">${countDisplay}</span>
        <span class="file-dir">${escapeHtml(dir)}</span>
        <span class="annotation-time">${timeAgo}</span>
      </li>
    `
  }

  private attachRecentAnnotationListeners(): void {
    this.recentAnnotationsList.querySelectorAll('.recent-annotation-item').forEach(item => {
      item.addEventListener('click', () => {
        const fullPath = (item as HTMLElement).dataset.path
        const originId = (item as HTMLElement).dataset.origin
        if (fullPath && originId && this.onOpenFile && this.currentCity) {
          this.onOpenFile(fullPath, originId, this.currentCity.path)
        }
      })
    })
  }

  private renderRecentFiles(files: RecentFile[]): void {
    if (!files || files.length === 0) {
      this.recentFilesList.innerHTML = '<li class="empty">No recent files</li>'
      return
    }

    // Show top 10
    const top10 = files.slice(0, 10)
    this.recentFilesList.innerHTML = top10.map(f => this.renderRecentFile(f)).join('')
    this.attachRecentFilesListeners()
  }

  private renderRecentFile(file: RecentFile): string {
    const fileName = file.path.split('/').pop() || file.path
    const dir = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : ''
    const timeAgo = formatTimeAgo(file.mtime)

    return `
      <li class="recent-file-item" data-path="${escapeHtml(file.fullPath)}">
        <span class="file-name">${escapeHtml(fileName)}</span>
        <span class="file-dir">${escapeHtml(dir)}</span>
        <span class="file-time">${timeAgo}</span>
      </li>
    `
  }

  private attachRecentFilesListeners(): void {
    this.recentFilesList.querySelectorAll('.recent-file-item').forEach(item => {
      item.addEventListener('click', () => {
        const fullPath = (item as HTMLElement).dataset.path
        if (fullPath && this.currentCity && this.onOpenFile) {
          this.onOpenFile(fullPath, this.currentCity.originId, this.currentCity.path)
        }
      })
    })
  }

  private renderFibers(open: Fiber[], closed: Fiber[]): void {
    this.openFibers = open
    this.closedFibers = closed

    // Render open fibers
    if (open.length === 0) {
      this.openFibersList.innerHTML = '<li class="empty">No open fibers</li>'
    } else {
      this.openFibersList.innerHTML = open.map(f => this.renderFiberItem(f)).join('')
    }

    // Render closed fibers
    if (closed.length === 0) {
      this.closedFibersList.innerHTML = '<li class="empty">None recently</li>'
    } else {
      this.closedFibersList.innerHTML = closed.map(f => this.renderFiberItem(f)).join('')
    }

    this.attachFiberClickListeners()
    this.attachHandoffListeners()
  }

  private renderFiberItem(fiber: Fiber): string {
    const statusIcon = fiber.status === 'active' ? '◐' : fiber.status === 'closed' ? '●' : '○'
    const kindClass = fiber.kind || 'task'

    return `
      <li class="fiber-item ${kindClass}" data-id="${fiber.id}">
        <div class="fiber-header">
          <span class="fiber-status">${statusIcon}</span>
          <span class="fiber-title">${escapeHtml(fiber.title)}</span>
          <span class="fiber-kind">${fiber.kind || 'task'}</span>
          <button class="handoff-btn" data-fiber-id="${fiber.id}" title="Hand off to Claude">↗</button>
        </div>
      </li>
    `
  }

  private attachFiberClickListeners(): void {
    this.panel.querySelectorAll('.fiber-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't open if clicking on handoff button
        if ((e.target as HTMLElement).closest('.handoff-btn')) return

        const fiberId = (item as HTMLElement).dataset.id
        if (fiberId && this.currentCity && this.onOpenFile) {
          const feltPath = `${this.currentCity.path}/.felt/${fiberId}.md`
          this.onOpenFile(feltPath, this.currentCity.originId, this.currentCity.path)
        }
      })
    })
  }

  private attachHandoffListeners(): void {
    this.panel.querySelectorAll('.handoff-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const fiberId = (btn as HTMLElement).dataset.fiberId
        if (fiberId && this.currentCity) {
          this.sendHandoff(fiberId, this.currentCity.path)
        }
      })
    })
  }

  private sendHandoff(fiberId: string, cityPath: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('No connection for handoff')
      return
    }
    this.ws.send(JSON.stringify({ type: 'handoff', fiberId, cityPath }))
  }

  private async requestNewWorker(): Promise<void> {
    if (!this.currentCity) {
      console.error('No city selected')
      return
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('No connection for new worker')
      return
    }
    if (!this.newWorkerDialog) {
      console.error('No new worker dialog set')
      return
    }
    const result = await this.newWorkerDialog.show(this.currentCity.name)
    if (!result) return
    console.log('Requesting new worker for:', this.currentCity.path, 'name:', result.name, 'chrome:', result.chrome, 'continue:', result.continue)
    this.ws.send(JSON.stringify({
      type: 'newWorker',
      cityPath: this.currentCity.path,
      name: result.name || undefined,
      chrome: result.chrome || undefined,
      continue: result.continue || undefined,
    }))
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

  /**
   * Get file paths from recent files for navigation
   */
  getRecentFilePaths(): string[] {
    const files = this.currentCity?.recentFiles || []
    return files.slice(0, 10).map(f => f.fullPath)
  }

  /**
   * Get index of a file in the recent files list
   */
  getRecentFileIndex(fullPath: string): number {
    const files = this.currentCity?.recentFiles || []
    return files.slice(0, 10).findIndex(f => f.fullPath === fullPath)
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

  show(city: City): void {
    this.currentCity = city
    this.cityName.textContent = city.name
    this.cityPath.textContent = city.path

    // Render git status
    this.renderGitStatus(city.gitStatus)

    // Show/hide View Claims button
    this.viewClaimsBtn.style.display = city.hasClaims ? 'block' : 'none'

    // Show/hide View Playgrounds button
    this.viewPlaygroundsBtn.style.display = city.hasPlaygrounds ? 'block' : 'none'

    // Clear search
    this.searchInput.value = ''
    this.searchQuery = ''
    this.searchResults = []
    this.updateSearchClearVisibility()
    this.showTabContent()

    // Reset to files tab
    this.setActiveTab('files')

    // Load files tab content
    this.recentAnnotationsList.innerHTML = '<li class="loading">Loading...</li>'
    this.recentFilesList.innerHTML = '<li class="loading">Loading...</li>'
    this.fetchRecentAnnotations()
    this.renderRecentFiles(city.recentFiles || [])

    // Load fibers tab content
    this.openFibersList.innerHTML = '<li class="loading">Loading fibers...</li>'
    this.closedFibersList.innerHTML = ''

    // Ignore the click that triggered this show
    this.ignoreNextClick = true

    // Attach document listeners (dynamically to avoid HMR stacking)
    this.attachDocumentListeners()

    // Show panel
    this.panel.classList.add('visible')

    // Request fibers from server
    this.requestFibers(city.id)
  }

  private renderGitStatus(status?: GitStatus): void {
    if (!status || !status.isRepo) {
      this.gitStatusEl.innerHTML = ''
      this.gitStatusEl.style.display = 'none'
      return
    }

    this.gitStatusEl.style.display = 'block'

    const parts: string[] = []

    parts.push(`<span class="git-branch">${escapeHtml(status.branch)}</span>`)

    if (status.ahead > 0 || status.behind > 0) {
      const syncParts: string[] = []
      if (status.ahead > 0) syncParts.push(`↑${status.ahead}`)
      if (status.behind > 0) syncParts.push(`↓${status.behind}`)
      parts.push(`<span class="git-sync">${syncParts.join(' ')}</span>`)
    }

    const changes: string[] = []
    if (status.staged.added > 0 || status.staged.modified > 0 || status.staged.deleted > 0) {
      const staged = status.staged.added + status.staged.modified + status.staged.deleted
      changes.push(`<span class="git-staged" title="Staged changes">●${staged}</span>`)
    }
    if (status.unstaged.modified > 0 || status.unstaged.deleted > 0) {
      const unstaged = status.unstaged.modified + status.unstaged.deleted
      changes.push(`<span class="git-unstaged" title="Unstaged changes">○${unstaged}</span>`)
    }
    if (status.untracked > 0) {
      changes.push(`<span class="git-untracked" title="Untracked files">?${status.untracked}</span>`)
    }
    if (changes.length > 0) {
      parts.push(changes.join(' '))
    }

    if (status.linesAdded > 0 || status.linesRemoved > 0) {
      const lineParts: string[] = []
      if (status.linesAdded > 0) lineParts.push(`<span class="git-add">+${status.linesAdded}</span>`)
      if (status.linesRemoved > 0) lineParts.push(`<span class="git-remove">-${status.linesRemoved}</span>`)
      parts.push(lineParts.join(' '))
    }

    this.gitStatusEl.innerHTML = parts.join(' · ')
  }

  private requestFibers(cityId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.openFibersList.innerHTML = '<li class="empty">No connection</li>'
      return
    }

    this.fibersCallback = (response) => {
      if (response.cityId === this.currentCity?.id) {
        this.renderFibers(response.open, response.recentlyClosed)
      }
    }

    this.ws.send(JSON.stringify({ type: 'getFibers', cityId }))
  }

  hide(): void {
    this.panel.classList.remove('visible')
    this.currentCity = null
    this.detachDocumentListeners()
    this.detachResizeListeners()
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }
}
