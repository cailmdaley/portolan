import type { City } from '../state/types'
import { escapeHtml, fiberStatusIcon } from './utils'
import type { Fiber, SearchResult } from './hud-types'

interface FibersResponse {
  type: 'fibers'
  cityId: string
  open: Fiber[]
  recentlyClosed: Fiber[]
}

type HudTab = 'fibers' | 'files'

interface CityHUDContentHost {
  sidebar: HTMLElement
  fiberList: HTMLElement
  filesList: HTMLElement
  searchInput: HTMLInputElement
  searchClear: HTMLElement
  searchResultsList: HTMLElement
  getCurrentCity: () => City | null
  getCurrentTab: () => HudTab
  getWebSocket: () => WebSocket | null
  getOnOpenFile: () => ((fullPath: string, originId: string, cityPath: string, cityId: string, line?: number) => void) | null
  renderEmptyFileSearchState: () => void
}

export class CityHUDContent {
  private host: CityHUDContentHost
  private fibersCallback: ((response: FibersResponse) => void) | null = null
  private currentSearchId = 0
  private searchResults: SearchResult[] = []
  private searchQuery = ''
  private openFibers: Fiber[] = []
  private closedFibers: Fiber[] = []

  constructor(host: CityHUDContentHost) {
    this.host = host
    this.setupSearch()
    this.setupDelegatedListeners()
  }

  reset(): void {
    this.fibersCallback = null
    this.currentSearchId = 0
    this.searchResults = []
    this.openFibers = []
    this.closedFibers = []
    this.clearSearch()
    this.host.fiberList.innerHTML = ''
  }

  handleTabChange(tab: HudTab): void {
    this.clearSearch()
    this.host.searchInput.placeholder = tab === 'fibers' ? 'Search fibers & files…' : 'Search files…'
  }

  hasSearchActivity(): boolean {
    return this.searchQuery.length > 0 || this.host.sidebar.classList.contains('searching')
  }

  getRuntimeStats(): {
    openFibers: number
    closedFibers: number
    searchQueryLength: number
    pendingSearchResults: number
  } {
    return {
      openFibers: this.openFibers.length,
      closedFibers: this.closedFibers.length,
      searchQueryLength: this.searchQuery.length,
      pendingSearchResults: this.searchResults.length,
    }
  }

  requestFibers(cityId: string): void {
    const ws = this.host.getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.host.fiberList.innerHTML = '<li class="hud-fiber-empty">No connection</li>'
      return
    }

    this.host.fiberList.innerHTML = '<li class="hud-fiber-empty hud-fiber-loading">Loading…</li>'
    this.fibersCallback = (response) => {
      if (response.cityId === this.host.getCurrentCity()?.id) {
        this.renderFibers(response.open, response.recentlyClosed)
      }
    }
    ws.send(JSON.stringify({ type: 'getFibers', cityId }))
  }

  handleMessage(message: unknown): boolean {
    const msg = message as { type?: string }
    if (msg.type === 'fibers') {
      const response = message as FibersResponse
      this.fibersCallback?.(response)
      this.fibersCallback = null
      return true
    }
    if (msg.type === 'searchResults') {
      const response = message as { searchId: string; results: SearchResult[]; error?: string }
      this.handleSearchResults(response.searchId, response.results, response.error)
      return true
    }
    return false
  }

  clearSearch(): void {
    this.searchQuery = ''
    this.host.searchInput.value = ''
    this.host.searchClear.style.display = 'none'
    this.host.sidebar.classList.remove('search-focused')

    this.collapseSearch()
    if (this.host.getCurrentTab() === 'files') {
      this.host.renderEmptyFileSearchState()
    }
  }

  private setupSearch(): void {
    this.host.searchInput.addEventListener('input', () => {
      this.searchQuery = this.host.searchInput.value.trim()
      this.host.searchClear.style.display = this.host.searchInput.value ? 'block' : 'none'

      if (!this.searchQuery) {
        this.collapseSearch()
      } else if (this.host.getCurrentTab() === 'fibers') {
        this.performSearch()
      }
    })

    this.host.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && this.searchQuery) {
        this.performSearch()
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        this.clearSearch()
        this.host.searchInput.blur()
      }
    })

    this.host.searchInput.addEventListener('focus', () => {
      this.host.sidebar.classList.add('search-focused')
    })

    this.host.searchInput.addEventListener('blur', () => {
      if (!this.searchQuery) {
        this.host.sidebar.classList.remove('search-focused')
      }
    })

    this.host.searchClear.addEventListener('click', () => {
      this.clearSearch()
      this.host.searchInput.focus()
    })
  }

  private setupDelegatedListeners(): void {
    this.host.fiberList.addEventListener('click', (event) => {
      const handoff = (event.target as HTMLElement).closest<HTMLElement>('.hud-fiber-handoff')
      if (handoff) {
        event.stopPropagation()
        const fiberId = handoff.dataset.fiberId
        const currentCity = this.host.getCurrentCity()
        const ws = this.host.getWebSocket()
        if (fiberId && currentCity && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'handoff',
            fiberId,
            cityPath: currentCity.path,
          }))
        }
        return
      }

      const item = (event.target as HTMLElement).closest<HTMLElement>('.hud-fiber-item')
      if (!item) return
      this.openFiber(item.dataset.fiberId)
    })

    this.host.searchResultsList.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('.hud-search-item')
      if (!item) return
      if (item.dataset.type === 'file') {
        const line = item.dataset.line ? parseInt(item.dataset.line, 10) : undefined
        this.openFile(item.dataset.path, line)
        return
      }
      if (item.dataset.type === 'fiber') {
        this.openFiber(item.dataset.fiberId)
      }
    })
  }

  private handleSearchResults(searchId: string, results: SearchResult[], error?: string): void {
    if (!this.searchQuery) return
    const expectedPrefix = `${this.host.getCurrentCity()?.id || ''}-${this.currentSearchId}`
    if (!searchId.startsWith(expectedPrefix)) return
    if (error) {
      console.error('Search error:', error)
      return
    }
    for (const result of results) {
      if (!this.searchResults.some(existing => existing.fullPath === result.fullPath)) {
        this.searchResults.push(result)
      }
    }
    this.renderSearchResults()
  }

  private performSearch(): void {
    this.searchResults = []
    this.host.sidebar.classList.add('searching')
    this.host.fiberList.style.display = 'none'
    this.host.filesList.style.display = 'none'
    this.host.searchResultsList.style.display = 'block'
    this.host.searchResultsList.innerHTML = '<li class="hud-search-loading">Searching…</li>'

    const currentCity = this.host.getCurrentCity()
    const ws = this.host.getWebSocket()
    if (currentCity && ws?.readyState === WebSocket.OPEN) {
      const searchId = `${currentCity.id}-${++this.currentSearchId}`
      ws.send(JSON.stringify({
        type: 'searchFiles',
        cityId: currentCity.id,
        query: this.searchQuery,
        searchId: `${searchId}-name`,
        mode: 'filename',
      }))
    }

    this.renderSearchResults()
  }

  private collapseSearch(): void {
    this.host.sidebar.classList.remove('searching')
    this.searchResults = []
    this.host.searchResultsList.style.display = 'none'
    if (this.host.getCurrentTab() === 'files') {
      this.host.filesList.style.display = ''
      return
    }
    this.host.fiberList.style.display = ''
  }

  private filterFibersLocally(query: string): Fiber[] {
    const normalizedQuery = query.toLowerCase()
    return [...this.openFibers, ...this.closedFibers].filter(fiber =>
      fiber.title.toLowerCase().includes(normalizedQuery) ||
      fiber.kind.toLowerCase().includes(normalizedQuery) ||
      fiber.id.toLowerCase().includes(normalizedQuery) ||
      (fiber.body?.toLowerCase().includes(normalizedQuery) ?? false) ||
      (fiber.reason?.toLowerCase().includes(normalizedQuery) ?? false)
    )
  }

  private renderSearchResults(): void {
    const currentTab = this.host.getCurrentTab()
    const fibers = currentTab === 'fibers' ? this.filterFibersLocally(this.searchQuery) : []
    const files = currentTab === 'files' ? this.searchResults.slice(0, 20) : []

    if (fibers.length === 0 && files.length === 0) {
      if (this.host.searchResultsList.querySelector('.hud-search-loading')) return
      this.host.searchResultsList.innerHTML = '<li class="hud-search-empty">No matches</li>'
      return
    }

    let html = ''

    for (const fiber of fibers.slice(0, 20)) {
      const kind = fiber.kind || 'task'
      html += `
        <li class="hud-search-item hud-fiber-item ${kind}" data-type="fiber" data-fiber-id="${fiber.id}">
          <span class="hud-fiber-status">${fiberStatusIcon(fiber.status)}</span>
          <span class="hud-fiber-title">${escapeHtml(fiber.title)}</span>
          <span class="hud-fiber-kind">${kind}</span>
        </li>`
    }

    for (const result of files) {
      const fileName = result.path.split('/').pop() || result.path
      const lineInfo = result.line !== undefined ? `:${result.line}` : ''
      const lineAttr = result.line !== undefined ? ` data-line="${result.line}"` : ''
      html += `
        <li class="hud-search-item hud-fiber-item file" data-type="file" data-path="${escapeHtml(result.fullPath)}"${lineAttr}>
          <span class="hud-search-icon">▹</span>
          <span class="hud-fiber-title mono">${escapeHtml(fileName)}${lineInfo}</span>
        </li>`
    }

    this.host.searchResultsList.innerHTML = html
  }

  private renderFibers(open: Fiber[], closed: Fiber[]): void {
    this.openFibers = open
    this.closedFibers = closed

    const allFibers = [...open, ...closed]
    if (allFibers.length === 0) {
      this.host.fiberList.innerHTML = '<li class="hud-fiber-empty">No fibers</li>'
      return
    }

    this.host.fiberList.innerHTML = allFibers.map(fiber => this.renderFiberItem(fiber)).join('')
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
    const currentCity = this.host.getCurrentCity()
    const onOpenFile = this.host.getOnOpenFile()
    if (!fiberId || !currentCity || !onOpenFile) return
    onOpenFile(`${currentCity.path}/.felt/${fiberId}.md`, currentCity.originId, currentCity.path, currentCity.id)
  }

  private openFile(fullPath: string | undefined, line?: number): void {
    const currentCity = this.host.getCurrentCity()
    const onOpenFile = this.host.getOnOpenFile()
    if (!fullPath || !currentCity || !onOpenFile) return
    onOpenFile(fullPath, currentCity.originId, currentCity.path, currentCity.id, line)
  }
}
