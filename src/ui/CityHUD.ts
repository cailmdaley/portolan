import type { City, ServerMeetingBridgeState, Session } from '../state/types'
import { CityHUDContent } from './CityHUDContent'
import { CityHUDFileTree } from './CityHUDFileTree'
import { CityHUDHeader } from './CityHUDHeader'
import type { NewWorkerDialog } from './NewWorkerDialog'
import type { Fiber } from './hud-types'

type HudTab = 'fibers' | 'files'

export class CityHUD {
  private container: HTMLElement
  private sidebar: HTMLElement
  private headerWidget: HTMLElement
  private fiberList: HTMLElement
  private filesList: HTMLElement
  private currentCity: City | null = null
  private ws: WebSocket | null = null
  private ignoreNextClick = false

  private activeTab: HudTab = 'files'

  private content: CityHUDContent
  private fileTree: CityHUDFileTree
  private header: CityHUDHeader

  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null

  private onViewClaims: ((city: City) => void) | null = null
  private onViewPlaygrounds: ((city: City) => void) | null = null
  private onOpenFile: ((fullPath: string, originId: string, cityPath: string, cityId: string, line?: number) => void) | null = null
  private onOpenDirectory: ((fullPath: string, originId: string, cityPath: string, cityId: string) => void) | null = null
  private onFocusWorker: ((sessionId: string) => void) | null = null
  private onPinnedFiberHover: ((slug: string | null) => void) | null = null
  private newWorkerDialog: NewWorkerDialog | null = null

  constructor() {
    this.container = this.createContainer()
    this.sidebar = this.container.querySelector('.hud-sidebar')!
    this.headerWidget = this.container.querySelector('.hud-header')!
    this.fiberList = this.container.querySelector('.hud-fiber-list')!
    this.filesList = this.container.querySelector('.hud-file-tree')!
    this.fileTree = new CityHUDFileTree({
      list: this.filesList,
      onOpenFile: (fullPath) => this.openFile(fullPath),
    })
    this.onOpenDirectory = (fullPath) => this.openDirectory(fullPath)
    this.header = new CityHUDHeader({
      headerWidget: this.headerWidget,
      getCurrentCity: () => this.currentCity,
      getWebSocket: () => this.ws,
      getNewWorkerDialog: () => this.newWorkerDialog,
      getOnViewClaims: () => this.onViewClaims,
      getOnViewPlaygrounds: () => this.onViewPlaygrounds,
      getOnOpenFile: () => this.onOpenFile,
      getOnFocusWorker: () => this.onFocusWorker,
    })
    this.content = new CityHUDContent({
      sidebar: this.sidebar,
      fiberList: this.fiberList,
      filesList: this.filesList,
      searchInput: this.container.querySelector('.hud-search-input')!,
      searchClear: this.container.querySelector('.hud-search-clear')!,
      searchResultsList: this.container.querySelector('.hud-search-results')!,
      getCurrentCity: () => this.currentCity,
      getCurrentTab: () => this.activeTab,
      getWebSocket: () => this.ws,
      getOnOpenFile: () => this.onOpenFile,
      getOnOpenDirectory: () => this.onOpenDirectory,
      getOnPinnedFiberHover: () => this.onPinnedFiberHover,
      renderEmptyFileSearchState: () => this.fileTree.renderEmptySearchState(),
    })
    this.setupEventHandlers()
    this.setupTabs()
    document.body.appendChild(this.container)
  }

  private createContainer(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'city-hud'
    el.innerHTML = `
      <div class="hud-sidebar">
        <div class="hud-header">
          <div class="hud-header-row">
            <h2 class="hud-city-name"></h2>
            <div class="hud-header-controls">
              <div class="hud-actions"></div>
              <button class="hud-close" title="Close" aria-label="Close city HUD">&times;</button>
            </div>
          </div>
          <p class="hud-city-path"></p>
          <div class="hud-git-detail-content"></div>
          <div class="hud-header-workers"></div>
          <div class="hud-header-meeting"></div>
        </div>

        <div class="hud-tabbar">
          <button class="hud-tab" data-tab="fibers">Fibers</button>
          <button class="hud-tab active" data-tab="files">Files</button>
        </div>

        <div class="hud-content">
          <ul class="hud-search-results" style="display: none;"></ul>
          <div class="hud-pane hud-pane-fibers">
            <ul class="hud-fiber-list"></ul>
          </div>
          <div class="hud-pane hud-pane-files active">
            <ul class="hud-file-tree"></ul>
          </div>
        </div>

        <div class="hud-search-bar">
          <input type="text" class="hud-search-input" placeholder="Search files &amp; fibers…" />
          <button class="hud-search-clear" style="display: none;" aria-label="Clear search">&times;</button>
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
      const path = e.composedPath()
      if (path.includes(this.container)) return
      const target = e.target as HTMLElement
      const vellumModal = document.querySelector('.vellum-modal-scrim')
      if (vellumModal?.contains(target)) return
      this.hide()
    }

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.container.classList.contains('visible')) return
      const vellumModal = document.querySelector('.vellum-modal-scrim')
      if (vellumModal) return
      if (this.content.hasSearchActivity()) {
        this.content.clearSearch()
        return
      }
      this.hide()
    }

    this.container.querySelector('.hud-close')?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.hide()
    })
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

  private setupTabs(): void {
    const tabBar = this.container.querySelector('.hud-tabbar')!
    tabBar.addEventListener('click', (e) => {
      const tabBtn = (e.target as HTMLElement).closest<HTMLElement>('.hud-tab')
      if (!tabBtn) return
      const tab = tabBtn.dataset.tab as HudTab | undefined
      if (!tab || tab === this.activeTab) return
      this.switchTab(tab)
    })
  }

  private switchTab(tab: HudTab): void {
    this.activeTab = tab

    for (const btn of this.container.querySelectorAll<HTMLElement>('.hud-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === tab)
    }
    for (const pane of this.container.querySelectorAll<HTMLElement>('.hud-pane')) {
      const isActive = pane.classList.contains(`hud-pane-${tab}`)
      pane.classList.toggle('active', isActive)
      pane.style.display = isActive ? '' : 'none'
    }

    this.content.handleTabChange(tab)
    if (tab === 'files') {
      this.fileTree.ensureRootListing()
    }
  }

  show(city: City): void {
    if (document.querySelector('.tapestry-view.visible')) return

    this.currentCity = city
    this.headerWidget.querySelector('.hud-city-name')!.textContent = city.name
    this.headerWidget.querySelector('.hud-city-path')!.textContent = city.path
    this.header.show(city)

    this.fileTree.setCurrentCity(city)
    this.fileTree.reset()
    this.content.reset()

    this.activeTab = 'files'
    this.switchTab('files')

    this.ignoreNextClick = true
    this.attachDocumentListeners()
    this.container.classList.add('visible')
    this.content.requestFibers(city.id)
  }

  hide(): void {
    this.container.classList.remove('visible')
    this.currentCity = null
    this.fileTree.setCurrentCity(null)
    this.detachDocumentListeners()
    this.content.clearSearch()
    this.fileTree.reset()
    this.header.reset()
  }

  isVisible(): boolean {
    return this.container.classList.contains('visible')
  }

  getCurrentCity(): City | null {
    return this.currentCity
  }

  getFibers(): { open: Fiber[]; closed: Fiber[] } {
    return this.content.getFibers()
  }

  setPinnedSlugs(slugs: Set<string>): void {
    this.content.setPinnedSlugs(slugs)
  }

  /** Reflect map-pin hover back into the HUD: the matching `.hud-fiber-item`
   *  gets a `.map-hovered` class so the user can see which HUD entry
   *  corresponds to the lifted card on the map. Pair to
   *  `setOnPinnedFiberHover`, which bridges the other direction. */
  setMapHoveredFiber(slug: string | null): void {
    const prev = this.sidebar.querySelectorAll<HTMLElement>('.hud-fiber-item.map-hovered')
    prev.forEach((el) => el.classList.remove('map-hovered'))
    if (!slug) return
    const next = this.sidebar.querySelectorAll<HTMLElement>(
      `.hud-fiber-item[data-fiber-id="${CSS.escape(slug)}"]`,
    )
    next.forEach((el) => el.classList.add('map-hovered'))
  }

  getRuntimeStats(): {
    visible: boolean
    activeTab: 'fibers' | 'files'
    currentCityId: string | null
    openFibers: number
    closedFibers: number
    searchQueryLength: number
    pendingSearchResults: number
    cityWorkerCount: number
    directoryCacheEntries: number
    expandedDirectoryCount: number
    loadingDirectoryCount: number
    directoryErrorCount: number
    inFlightDirectoryRequestCount: number
  } {
    return {
      visible: this.isVisible(),
      activeTab: this.activeTab,
      currentCityId: this.currentCity?.id ?? null,
      ...this.header.getRuntimeStats(),
      ...this.content.getRuntimeStats(),
      ...this.fileTree.getRuntimeStats(),
    }
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws
    this.fileTree.setWebSocket(ws)
  }

  setOnViewClaims(callback: (city: City) => void): void {
    this.onViewClaims = callback
  }

  setOnViewPlaygrounds(callback: (city: City) => void): void {
    this.onViewPlaygrounds = callback
  }

  setOnOpenFile(callback: (fullPath: string, originId: string, cityPath: string, cityId: string, line?: number) => void): void {
    this.onOpenFile = callback
  }

  setOnOpenDirectory(callback: (fullPath: string, originId: string, cityPath: string, cityId: string) => void): void {
    this.onOpenDirectory = callback
  }

  setNewWorkerDialog(dialog: NewWorkerDialog): void {
    this.newWorkerDialog = dialog
  }

  setOnPinnedFiberHover(callback: (slug: string | null) => void): void {
    this.onPinnedFiberHover = callback
  }

  setOnFocusWorker(callback: (sessionId: string) => void): void {
    this.onFocusWorker = callback
  }

  updateWorkers(sessions: Session[]): void {
    if (!this.currentCity || !this.container.classList.contains('visible')) return
    this.header.updateWorkers(sessions)
  }

  updateMeetingState(meetingBridge: ServerMeetingBridgeState | null): void {
    this.header.updateMeetingState(meetingBridge)
  }

  handleMessage(message: unknown): boolean {
    if (this.content.handleMessage(message)) return true
    if (this.fileTree.handleMessage(message)) return true
    return false
  }

  private openFile(fullPath: string | undefined, line?: number): void {
    if (!fullPath || !this.currentCity || !this.onOpenFile) return
    this.onOpenFile(fullPath, this.currentCity.originId, this.currentCity.path, this.currentCity.id, line)
  }

  private openDirectory(fullPath: string | undefined): void {
    if (!fullPath || !this.currentCity) return
    this.switchTab('files')
    this.fileTree.openDirectory(fullPath)
  }

  dispose(): void {
    this.hide()
    this.container.remove()
  }
}
