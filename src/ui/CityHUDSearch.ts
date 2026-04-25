import type { City } from '../state/types'
import { escapeHtml } from './utils'
import type { SearchResult } from './hud-types'

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
  onOpenFile: (fullPath: string | undefined, line?: number) => void
  onOpenDirectory: (fullPath: string | undefined) => void
  renderEmptyFileSearchState: () => void
  // Fiber search drives a tree-prune in CityHUDContent rather than the
  // flat searchResultsList. Pass '' to clear.
  onFiberSearchChange: (query: string) => void
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
        return
      }
      if (this.host.getCurrentTab() === 'fibers') {
        // Fiber search prunes the tree in place — keep fiberList visible,
        // hand the query off to CityHUDContent.
        this.host.sidebar.classList.add('searching')
        this.host.fiberList.style.display = ''
        this.host.filesList.style.display = 'none'
        this.host.searchResultsList.style.display = 'none'
        this.host.onFiberSearchChange(this.searchQuery)
      } else {
        this.performSearch()
      }
    })

    this.host.searchInput.addEventListener('keydown', (event) => {
      // Fiber search updates live on every input event already; only the
      // files tab needs an Enter-to-search semantic (it's a server query).
      if (event.key === 'Enter' && this.searchQuery && this.host.getCurrentTab() === 'files') {
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
    this.host.onFiberSearchChange('')
    if (this.host.getCurrentTab() === 'files') {
      this.host.filesList.style.display = ''
      return
    }
    this.host.fiberList.style.display = ''
  }

  private renderSearchResults(): void {
    // Files-only path: fiber search renders into the fiber tree directly
    // (CityHUDContent.setFiberSearchQuery), bypassing this list entirely.
    const files = this.searchResults.slice(0, 20)

    if (files.length === 0) {
      if (this.host.searchResultsList.querySelector('.hud-search-loading')) return
      this.host.searchResultsList.innerHTML = '<li class="hud-search-empty">No matches</li>'
      return
    }

    let html = ''
    for (const result of files) {
      const fileName = result.path.split('/').pop() || result.path
      const lineInfo = result.line !== undefined ? `:${result.line}` : ''
      const lineAttr = result.line !== undefined ? ` data-line="${result.line}"` : ''
      const itemType = result.type === 'dir' ? 'dir' : 'file'
      const icon = result.type === 'dir' ? '▸' : '▹'
      const displayName = result.type === 'dir' ? `${fileName}/` : `${fileName}${lineInfo}`
      // The trigger button carries the click + keyboard semantics. The row
      // delegate at line 141 still uses `closest('.hud-search-item')` so the
      // dataset on the <li> stays the source of truth; the button mirrors
      // data-path/data-type/data-line for ergonomics.
      const ariaLabel = result.type === 'dir'
        ? `Open ${escapeHtml(fileName)} (directory)${lineInfo ? ` line ${result.line}` : ''}`
        : `Open ${escapeHtml(fileName)} (file)${lineInfo ? ` line ${result.line}` : ''}`
      html += `
        <li class="hud-search-item hud-fiber-item ${itemType}" data-type="${itemType}" data-path="${escapeHtml(result.fullPath)}"${lineAttr}>
          <button type="button" class="hud-search-trigger" data-type="${itemType}" data-path="${escapeHtml(result.fullPath)}"${lineAttr} aria-label="${ariaLabel}">
            <span class="hud-search-icon" aria-hidden="true">${icon}</span>
            <span class="hud-fiber-title mono">${escapeHtml(displayName)}</span>
          </button>
        </li>`
    }

    this.host.searchResultsList.innerHTML = html
  }
}
