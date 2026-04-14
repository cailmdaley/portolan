import type { City } from '../state/types'
import { escapeHtml, fiberStatusIcon } from './utils'
import type { Fiber, SearchResult } from './hud-types'

type HudTab = 'fibers' | 'files'

interface SearchResultsMessage {
  type: 'searchResults'
  searchId: string
  results: SearchResult[]
  error?: string
}

interface CityHUDSearchHost {
  sidebar: HTMLElement
  fiberList: HTMLElement
  filesList: HTMLElement
  searchInput: HTMLInputElement
  searchClear: HTMLElement
  searchResultsList: HTMLElement
  getCurrentCity: () => City | null
  getCurrentTab: () => HudTab
  getWebSocket: () => WebSocket | null
  getFibers: () => { open: Fiber[]; closed: Fiber[] }
  getPinnedSlugs: () => Set<string>
  onOpenFiber: (fiberId: string | undefined) => void
  onOpenFile: (fullPath: string | undefined, line?: number) => void
  onOpenDirectory: (fullPath: string | undefined) => void
  renderEmptyFileSearchState: () => void
}

export class CityHUDSearch {
  private host: CityHUDSearchHost
  private currentSearchId = 0
  private searchResults: SearchResult[] = []
  private searchQuery = ''

  constructor(host: CityHUDSearchHost) {
    this.host = host
    this.setupSearch()
    this.setupDelegatedListeners()
  }

  reset(): void {
    this.currentSearchId = 0
    this.searchResults = []
    this.clear()
  }

  handleTabChange(tab: HudTab): void {
    this.clear()
    this.host.searchInput.placeholder = tab === 'fibers' ? 'Search fibers & files…' : 'Search files…'
  }

  hasActivity(): boolean {
    return this.searchQuery.length > 0 || this.host.sidebar.classList.contains('searching')
  }

  getRuntimeStats(): {
    searchQueryLength: number
    pendingSearchResults: number
  } {
    return {
      searchQueryLength: this.searchQuery.length,
      pendingSearchResults: this.searchResults.length,
    }
  }

  handleMessage(message: unknown): boolean {
    const msg = message as { type?: string }
    if (msg.type !== 'searchResults') return false
    const response = message as SearchResultsMessage
    this.handleSearchResults(response.searchId, response.results, response.error)
    return true
  }

  clear(): void {
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
        this.clear()
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
      this.clear()
      this.host.searchInput.focus()
    })
  }

  private setupDelegatedListeners(): void {
    this.host.searchResultsList.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('.hud-search-item')
      if (!item) return
      if (item.dataset.type === 'file') {
        const line = item.dataset.line ? parseInt(item.dataset.line, 10) : undefined
        this.host.onOpenFile(item.dataset.path, line)
        return
      }
      if (item.dataset.type === 'dir') {
        this.host.onOpenDirectory(item.dataset.path)
        return
      }
      if (item.dataset.type === 'fiber') {
        this.host.onOpenFiber(item.dataset.fiberId)
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
    const { open, closed } = this.host.getFibers()
    const normalizedQuery = query.toLowerCase()
    return [...open, ...closed].filter(fiber =>
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

    const pinnedSlugs = this.host.getPinnedSlugs()
    for (const fiber of fibers.slice(0, 20)) {
      const kind = fiber.kind || 'task'
      const pinned = pinnedSlugs.has(fiber.id) ? ' pinned' : ''
      html += `
        <li class="hud-search-item hud-fiber-item ${kind}${pinned}" data-type="fiber" data-fiber-id="${fiber.id}">
          <span class="hud-fiber-status">${fiberStatusIcon(fiber.status)}</span>
          <span class="hud-fiber-title">${escapeHtml(fiber.title)}</span>
          <span class="hud-fiber-kind">${kind}</span>
        </li>`
    }

    for (const result of files) {
      const fileName = result.path.split('/').pop() || result.path
      const lineInfo = result.line !== undefined ? `:${result.line}` : ''
      const lineAttr = result.line !== undefined ? ` data-line="${result.line}"` : ''
      const itemType = result.type === 'dir' ? 'dir' : 'file'
      const icon = result.type === 'dir' ? '▸' : '▹'
      const displayName = result.type === 'dir' ? `${fileName}/` : `${fileName}${lineInfo}`
      html += `
        <li class="hud-search-item hud-fiber-item ${itemType}" data-type="${itemType}" data-path="${escapeHtml(result.fullPath)}"${lineAttr}>
          <span class="hud-search-icon">${icon}</span>
          <span class="hud-fiber-title mono">${escapeHtml(displayName)}</span>
        </li>`
    }

    this.host.searchResultsList.innerHTML = html
  }
}
