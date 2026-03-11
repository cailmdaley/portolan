import type { City, GitStatus, Session } from '../state/types'
import { CityHUDContent } from './CityHUDContent'
import { CityHUDFileTree } from './CityHUDFileTree'
import { escapeHtml } from './utils'
import type { NewWorkerDialog } from './NewWorkerDialog'

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

  private cityWorkers: Session[] = []
  private content: CityHUDContent
  private fileTree: CityHUDFileTree

  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null

  private onViewClaims: ((city: City) => void) | null = null
  private onViewPlaygrounds: ((city: City) => void) | null = null
  private onOpenFile: ((fullPath: string, originId: string, cityPath: string, cityId: string, line?: number) => void) | null = null
  private onFocusWorker: ((sessionId: string) => void) | null = null
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
              <button class="hud-close" title="Close">&times;</button>
            </div>
          </div>
          <p class="hud-city-path"></p>
          <div class="hud-git-detail-content"></div>
          <div class="hud-header-workers"></div>
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
      const path = e.composedPath()
      if (path.includes(this.container)) return
      const target = e.target as HTMLElement
      const fileViewer = document.querySelector('.file-viewer-modal.visible')
      if (fileViewer?.contains(target)) return
      const fileViewerBackdrop = document.querySelector('.file-viewer-backdrop.visible')
      if (fileViewerBackdrop?.contains(target)) return
      this.hide()
    }

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.container.classList.contains('visible')) return
      const fileViewer = document.querySelector('.file-viewer-modal.visible')
      if (fileViewer) return
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

  private renderGitDetail(status?: GitStatus): void {
    const content = this.headerWidget.querySelector('.hud-git-detail-content')!
    if (!status?.isRepo) {
      content.innerHTML = ''
      return
    }

    const rows: string[] = []
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

    if (status.untracked > 0) {
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">untracked</span>
        <span class="hud-gd-value hud-gd-untracked">${status.untracked} file${status.untracked !== 1 ? 's' : ''}</span>
      </div>`)
    }

    if (status.linesAdded > 0 || status.linesRemoved > 0) {
      const parts: string[] = []
      if (status.linesAdded > 0) parts.push(`<span class="hud-git-add">+${status.linesAdded}</span>`)
      if (status.linesRemoved > 0) parts.push(`<span class="hud-git-rm">−${status.linesRemoved}</span>`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">diff</span>
        <span class="hud-gd-value">${parts.join(' ')}</span>
      </div>`)
    }

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

  private renderActions(city: City): void {
    const buttons: string[] = []
    if (city.hasClaims) {
      buttons.push(`<button class="hud-action-btn hud-action-claims" title="Claims">⚖</button>`)
    }
    if (city.hasPlaygrounds) {
      buttons.push(`<button class="hud-action-btn hud-action-playgrounds" title="Playgrounds">▶</button>`)
    }

    const row = this.headerWidget.querySelector('.hud-actions')!
    row.innerHTML = buttons.join('')

    row.querySelector('.hud-action-claims')?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.currentCity) this.onViewClaims?.(this.currentCity)
    })

    row.querySelector('.hud-action-playgrounds')?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.currentCity) this.onViewPlaygrounds?.(this.currentCity)
    })
  }

  show(city: City): void {
    if (document.querySelector('.tapestry-view.visible')) return

    this.currentCity = city
    this.headerWidget.querySelector('.hud-city-name')!.textContent = city.name
    this.headerWidget.querySelector('.hud-city-path')!.textContent = city.path
    this.renderGitDetail(city.gitStatus)
    this.renderActions(city)

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
  }

  isVisible(): boolean {
    return this.container.classList.contains('visible')
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
      cityWorkerCount: this.cityWorkers.length,
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

  setNewWorkerDialog(dialog: NewWorkerDialog): void {
    this.newWorkerDialog = dialog
  }

  setOnFocusWorker(callback: (sessionId: string) => void): void {
    this.onFocusWorker = callback
  }

  updateWorkers(sessions: Session[]): void {
    if (!this.currentCity || !this.container.classList.contains('visible')) return
    this.cityWorkers = sessions.filter(session => session.cityId === this.currentCity!.id)
    this.renderWorkers()
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

  private renderWorkers(): void {
    const container = this.headerWidget.querySelector('.hud-header-workers')!
    const parts: string[] = [`<span class="hud-header-workers-label">workers</span>`]

    const chips = this.cityWorkers.map(session => {
      const statusClass = session.status === 'working' ? 'working' : 'idle'
      return `<span class="hud-worker-chip ${statusClass}" data-session-id="${session.id}" title="${escapeHtml(session.name)}">` +
        `<span class="hud-worker-dot ${statusClass}">●</span>${escapeHtml(session.name)}</span>`
    })

    chips.push('<button class="hud-worker-add" title="New Worker">+</button>')
    container.innerHTML = parts.concat(chips).join('')

    for (const chip of container.querySelectorAll<HTMLElement>('.hud-worker-chip')) {
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        const sessionId = chip.dataset.sessionId
        if (sessionId) this.onFocusWorker?.(sessionId)
      })
    }

    container.querySelector('.hud-worker-add')?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.currentCity && this.newWorkerDialog) {
        this.newWorkerDialog.show(this.currentCity.name).then(result => {
          if (!result) return
          if (this.ws?.readyState === WebSocket.OPEN && this.currentCity) {
            this.ws.send(JSON.stringify({
              type: 'newWorker',
              cityPath: this.currentCity.path,
              name: result.name || undefined,
              cli: result.cli || undefined,
              chrome: result.chrome || undefined,
              continue: result.continue || undefined,
            }))
          }
        })
      }
    })
  }

  dispose(): void {
    this.hide()
    this.container.remove()
  }
}
