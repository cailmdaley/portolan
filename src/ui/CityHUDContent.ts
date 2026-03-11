import type { City } from '../state/types'
import { CityHUDSearch } from './CityHUDSearch'
import { escapeHtml, fiberStatusIcon } from './utils'
import type { Fiber } from './hud-types'

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
  private openFibers: Fiber[] = []
  private closedFibers: Fiber[] = []
  private search: CityHUDSearch

  constructor(host: CityHUDContentHost) {
    this.host = host
    this.search = new CityHUDSearch({
      sidebar: this.host.sidebar,
      fiberList: this.host.fiberList,
      filesList: this.host.filesList,
      searchInput: this.host.searchInput,
      searchClear: this.host.searchClear,
      searchResultsList: this.host.searchResultsList,
      getCurrentCity: () => this.host.getCurrentCity(),
      getCurrentTab: () => this.host.getCurrentTab(),
      getWebSocket: () => this.host.getWebSocket(),
      getFibers: () => ({ open: this.openFibers, closed: this.closedFibers }),
      onOpenFiber: (fiberId) => this.openFiber(fiberId),
      onOpenFile: (fullPath, line) => this.openFile(fullPath, line),
      renderEmptyFileSearchState: () => this.host.renderEmptyFileSearchState(),
    })
    this.setupDelegatedListeners()
  }

  reset(): void {
    this.fibersCallback = null
    this.openFibers = []
    this.closedFibers = []
    this.search.reset()
    this.host.fiberList.innerHTML = ''
  }

  handleTabChange(tab: HudTab): void {
    this.search.handleTabChange(tab)
  }

  hasSearchActivity(): boolean {
    return this.search.hasActivity()
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
      ...this.search.getRuntimeStats(),
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
      return this.search.handleMessage(message)
    }
    return false
  }

  clearSearch(): void {
    this.search.clear()
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
