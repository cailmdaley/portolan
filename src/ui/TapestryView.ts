// TapestryView — native DAG visualization for fibers.

import type { City } from '../state/types'
import { AnnotationPanel } from './AnnotationPanel'
import { TapestryArtifactLightbox } from './TapestryArtifactLightbox'
import { TapestryClaimsAnnotations } from './TapestryClaimsAnnotations'
import { TapestryDagGraph } from './TapestryDagGraph'
import { TapestryDetailBody } from './TapestryDetailBody'
import { TapestryDetailPanel } from './TapestryDetailPanel'
import { TapestryStaticFileModal } from './TapestryStaticFileModal'
import type { TapestryFiber, TapestryNode, TapestryResponse } from './tapestry-types'
import { artifactEntries, isPdfArtifact, shortName, statusIcon, stalenessColor } from './tapestry-helpers'
import { escapeHtml, interpolateConfig, showToast } from './utils'
import { type WorkerInfo } from './WorkerPicker'

export type { TapestryResponse } from './tapestry-types'

const API_BASE = `http://${window.location.hostname}:4004`
const PRELOAD_CACHE_LIMIT = 64
const SEARCH_SNIPPET_CONTEXT = 15

export class TapestryView {
  private panel: HTMLElement
  private closeBtn: HTMLElement
  private dagContainer: HTMLElement
  private detailPanel: HTMLElement
  private fiberListEl: HTMLElement
  private fiberSearchInput: HTMLInputElement
  private fiberResultsEl: HTMLElement
  private searchResults: HTMLElement
  private loadingIndicator: HTMLElement
  private annotationPanelEl: HTMLElement
  private graph: TapestryDagGraph
  private annotations: TapestryClaimsAnnotations
  private detailPanelController: TapestryDetailPanel

  private currentCity: City | null = null
  private tapestryData: TapestryResponse | null = null
  private selectedNodeId: string | null = null
  private staticMode = false
  private staticAssetBase = ''
  private staticDataBase = ''
  private searchFocusIdx = -1
  private preloadCache = new Map<string, HTMLImageElement>()
  private hideCleanupTimeout: ReturnType<typeof setTimeout> | null = null
  private dataFetchAbortController: AbortController | null = null
  private dataRequestId = 0
  private staticFileModal: TapestryStaticFileModal | null = null
  private lightbox = new TapestryArtifactLightbox(
    (specName, filePath) => this.artifactUrl(specName, filePath),
    (node, artifactName, x, y) => this.promptImageAnnotation(node, artifactName, x, y),
    () => this.staticMode,
  )
  private detailBody = new TapestryDetailBody()
  private disposed = false

  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private onGetWorkers: ((city: City) => WorkerInfo[]) | null = null
  private onOpenFile: ((path: string, city: City, line?: number) => void) | null = null

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.tapestry-close')!
    this.dagContainer = this.panel.querySelector('.tapestry-dag')!
    this.detailPanel = this.panel.querySelector('.tapestry-detail')!
    this.fiberListEl = this.panel.querySelector('.tapestry-fiber-list')!
    this.fiberSearchInput = this.panel.querySelector('.tapestry-fiber-search') as HTMLInputElement
    this.fiberResultsEl = this.panel.querySelector('.tapestry-fiber-results')!
    this.searchResults = this.panel.querySelector('.tapestry-search-results')!
    this.loadingIndicator = this.panel.querySelector('.tapestry-loading')!
    this.annotationPanelEl = this.panel.querySelector('.tapestry-annotation-panel')!
    this.graph = new TapestryDagGraph({
      container: this.dagContainer,
      onSelectNode: (id) => this.handleGraphSelection(id),
      onClearSelection: () => this.hideDetail(true),
    })
    this.annotations = new TapestryClaimsAnnotations({
      panelEl: this.annotationPanelEl,
      getContainer: () => this.panel,
      getCurrentCity: () => this.currentCity,
      getSelectedNodeId: () => this.selectedNodeId,
      getSelectedNode: () => {
        if (!this.tapestryData || !this.selectedNodeId) return null
        return this.tapestryData.nodes.find((node) => node.id === this.selectedNodeId) || null
      },
      getDetailBodyElement: () => this.detailPanel.querySelector('.tapestry-detail-body'),
      getWorkers: () => {
        if (!this.currentCity || !this.onGetWorkers) return []
        return this.onGetWorkers(this.currentCity)
      },
    })
    this.detailPanelController = new TapestryDetailPanel({
      panel: this.panel,
      detailPanel: this.detailPanel,
      fiberListEl: this.fiberListEl,
      getCurrentCity: () => this.currentCity,
      getTapestryData: () => this.tapestryData,
      isStaticMode: () => this.staticMode,
      getArtifactUrl: (specName, filePath) => this.artifactUrl(specName, filePath),
      openStaticFile: (href, line) => this.staticFileModal?.open(href, line),
      openFileFromLink: (href, line) => this.openFileFromLink(href, line),
      renderDetailBody: (container, body) => this.renderDetailBody(container, body),
      enterBodyEditMode: (node) => this.enterBodyEditMode(node),
      saveBodyAndExit: (node) => this.saveBodyAndExit(node),
      exitBodyEditMode: (node) => this.exitBodyEditMode(node),
      navigateToFiber: (fiberId) => this.navigateToFiber(fiberId),
      refreshCurrentNode: () => this.refreshCurrentNode(),
      hideDetail: () => this.hideDetail(),
      openArtifactLightbox: (media, node) => this.lightbox.open(media, node),
    })

    this.setupEventListeners()
    document.body.appendChild(this.panel)
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.className = 'tapestry-view'
    panel.innerHTML = `
      <button class="tapestry-close">&times;</button>
      <div class="tapestry-body">
        <div class="tapestry-main">
          <div class="tapestry-dag-wrapper">
            <div class="tapestry-loading">Loading tapestry\u2026</div>
            <div class="tapestry-dag"></div>
          </div>
          <div class="tapestry-sidebar">
            <div class="tapestry-sidebar-resize"></div>
            <div class="tapestry-fiber-list">
              <div class="tapestry-search">
                <input type="text" class="tapestry-fiber-search" placeholder="Search fibers\u2026" />
                <div class="tapestry-search-results"></div>
              </div>
              <div class="tapestry-legend">
                <span class="legend-item"><span style="color:#5A7B7B">\u25CF</span> fresh</span>
                <span class="legend-item"><span style="color:#A87070">\u25CF</span> stale</span>
                <span class="legend-item"><span style="color:#7A7368">\u25CF</span> no evidence</span>
                <span class="legend-sep">|</span>
                <span class="legend-item">\u25CB open</span>
                <span class="legend-item">\u25D0 active</span>
                <span class="legend-item">\u25CF closed</span>
              </div>
              <div class="tapestry-fiber-results"></div>
            </div>
            <div class="tapestry-detail hidden"></div>
          </div>
        </div>
        <div class="tapestry-annotation-panel hidden">
          ${AnnotationPanel.buildPanelHTML({
            globalCommentPlaceholder: 'General feedback\u2026',
          })}
        </div>
      </div>
    `
    return panel
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.hide())

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.isVisible()) return
      if (this.detailBody.isEditing()) {
        const node = this.tapestryData?.nodes.find((candidate) => candidate.id === this.detailBody.getEditingNodeId())
        if (node) this.exitBodyEditMode(node)
        return
      }
      if (this.detailPanel.classList.contains('hidden')) {
        this.hide()
      } else {
        this.hideDetail()
      }
    }

    this.fiberSearchInput.addEventListener('input', () => {
      this.handleSearch()
      this.renderFiberList()
    })
    this.fiberSearchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.fiberSearchInput.value = ''
        this.searchResults.innerHTML = ''
        this.clearSearchHighlights()
        this.searchFocusIdx = -1
        this.fiberSearchInput.blur()
        this.renderFiberList()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
        if (results.length === 0) return
        this.searchFocusIdx = e.key === 'ArrowDown'
          ? (this.searchFocusIdx + 1) % results.length
          : this.searchFocusIdx <= 0 ? results.length - 1 : this.searchFocusIdx - 1
        this.updateSearchFocus()
        return
      }
      if (e.key === 'Enter') {
        const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
        if (this.searchFocusIdx >= 0 && this.searchFocusIdx < results.length) {
          results[this.searchFocusIdx].click()
        }
      }
    })

    const sidebarResize = this.panel.querySelector('.tapestry-sidebar-resize')
    const sidebar = this.panel.querySelector('.tapestry-sidebar') as HTMLElement
    if (sidebarResize && sidebar) {
      sidebarResize.addEventListener('mousedown', (e) => {
        e.preventDefault()
        sidebar.style.transition = 'none'
        const startX = (e as MouseEvent).clientX
        const startWidth = sidebar.getBoundingClientRect().width
        const onMove = (ev: MouseEvent) => {
          const maxWidth = window.innerWidth * 0.85
          const newWidth = Math.max(300, Math.min(maxWidth, startWidth - (ev.clientX - startX)))
          sidebar.style.width = `${newWidth}px`
        }
        const onUp = () => {
          sidebar.style.transition = ''
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
    }

    let selectionTimeout: ReturnType<typeof setTimeout> | null = null
    this.detailPanel.addEventListener('mouseup', () => {
      if (this.staticMode) return
      selectionTimeout = setTimeout(() => {
        const selection = window.getSelection()
        if (selection && selection.toString().trim().length > 0) {
          this.annotations.handleTextSelection(selection)
        }
      }, 250)
    })
    this.detailPanel.addEventListener('dblclick', () => {
      if (selectionTimeout) {
        clearTimeout(selectionTimeout)
        selectionTimeout = null
      }
    })
  }

  private beginDataRequest(): { requestId: number; signal: AbortSignal } {
    this.dataFetchAbortController?.abort()
    const controller = new AbortController()
    this.dataFetchAbortController = controller
    const requestId = ++this.dataRequestId
    return { requestId, signal: controller.signal }
  }

  private isCurrentDataRequest(requestId: number): boolean {
    return !this.disposed && requestId === this.dataRequestId
  }

  private clearDataRequest(): void {
    this.dataFetchAbortController?.abort()
    this.dataFetchAbortController = null
  }

  private clearHideCleanupTimeout(): void {
    if (this.hideCleanupTimeout) {
      clearTimeout(this.hideCleanupTimeout)
      this.hideCleanupTimeout = null
    }
  }

  async show(city: City): Promise<void> {
    this.disposed = false
    this.clearHideCleanupTimeout()
    this.clearPreloadCache()

    this.currentCity = city
    this.selectedNodeId = null

    const incomingHash = window.location.hash
    this.annotations.hidePanel()
    this.annotations.reset()
    this.hideDetail()

    const url = new URL(window.location.href)
    url.searchParams.set('city', city.id)
    url.hash = incomingHash
    window.history.replaceState(null, '', url.toString())

    this.loadingIndicator.style.display = 'flex'
    this.loadingIndicator.textContent = 'Loading tapestry\u2026'
    this.loadingIndicator.classList.remove('error')
    this.dagContainer.innerHTML = ''

    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
    this.panel.classList.add('visible')

    const { requestId, signal } = this.beginDataRequest()
    try {
      const response = await fetch(`${API_BASE}/tapestry?cityId=${encodeURIComponent(city.id)}`, { signal })
      if (!response.ok) throw new Error(await response.text())
      const data = await response.json()
      if (!this.isCurrentDataRequest(requestId)) return
      this.tapestryData = data
      this.loadingIndicator.style.display = 'none'
      this.graph.render(data)
      this.renderFiberList()
      this.selectFromHash()
    } catch (err) {
      if (!this.isCurrentDataRequest(requestId)) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      this.loadingIndicator.textContent = 'Failed to load tapestry'
      this.loadingIndicator.classList.add('error')
      console.error('Tapestry fetch failed:', err)
    } finally {
      if (this.isCurrentDataRequest(requestId)) {
        this.dataFetchAbortController = null
      }
    }
  }

  hide(): void {
    this.clearDataRequest()
    this.clearHideCleanupTimeout()
    this.hideDetail(true)
    this.graph.clear()
    this.staticFileModal?.close()
    this.clearPreloadCache()

    this.panel.classList.remove('visible')
    this.panel.querySelector('.tapestry-ann-popover')?.remove()

    const url = new URL(window.location.href)
    url.searchParams.delete('city')
    url.hash = ''
    window.history.replaceState(null, '', url.toString())

    this.currentCity = null
    this.selectedNodeId = null
    this.tapestryData = null
    this.annotations.reset()

    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
    }

    this.hideCleanupTimeout = setTimeout(() => {
      if (!this.isVisible()) {
        this.detailPanel.innerHTML = ''
        this.detailPanel.classList.add('hidden')
      }
      this.hideCleanupTimeout = null
    }, 300)
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }

  getRuntimeStats(): {
    visible: boolean
    disposed: boolean
    staticMode: boolean
    currentCityId: string | null
    selectedNodeId: string | null
    expandedNodeCount: number
    visibleNodeCount: number
    hasSimulation: boolean
    hasSvg: boolean
    hasZoomBehavior: boolean
    preloadCacheSize: number
    transientFrameCount: number
    hasDataFetchRequest: boolean
    dataRequestId: number
    hasHideCleanupTimeout: boolean
    hasEscapeHandler: boolean
    hasArtifactClickHandler: boolean
    hasGalleryDetach: boolean
    hasStaticFileModal: boolean
    hasStaticFileModalKeyHandler: boolean
    hasLightboxCleanup: boolean
    hasTooltip: boolean
  } {
    const graphStats = this.graph.getRuntimeStats()
    return {
      visible: this.isVisible(),
      disposed: this.disposed,
      staticMode: this.staticMode,
      currentCityId: this.currentCity?.id ?? null,
      selectedNodeId: this.selectedNodeId,
      expandedNodeCount: graphStats.expandedNodeCount,
      visibleNodeCount: graphStats.visibleNodeCount,
      hasSimulation: graphStats.hasSimulation,
      hasSvg: graphStats.hasSvg,
      hasZoomBehavior: graphStats.hasZoomBehavior,
      preloadCacheSize: this.preloadCache.size,
      transientFrameCount: graphStats.transientFrameCount,
      hasDataFetchRequest: this.dataFetchAbortController !== null,
      dataRequestId: this.dataRequestId,
      hasHideCleanupTimeout: this.hideCleanupTimeout !== null,
      hasEscapeHandler: this.escapeHandler !== null,
      hasArtifactClickHandler: this.detailPanelController.getRuntimeStats().hasArtifactClickHandler,
      hasGalleryDetach: this.detailPanelController.getRuntimeStats().hasGalleryDetach,
      hasStaticFileModal: this.staticFileModal?.isOpen() ?? false,
      hasStaticFileModalKeyHandler: this.staticFileModal?.isOpen() ?? false,
      hasLightboxCleanup: this.lightbox.isOpen(),
      hasTooltip: graphStats.hasTooltip,
    }
  }

  dispose(): void {
    this.disposed = true
    this.hide()
    this.clearHideCleanupTimeout()
    this.detailPanelController.destroy()
    this.staticFileModal?.close()
    this.graph.destroy()
    this.panel.remove()
  }

  setOnGetWorkers(fn: (city: City) => WorkerInfo[]): void {
    this.onGetWorkers = fn
  }

  setOnOpenFile(fn: (path: string, city: City, line?: number) => void): void {
    this.onOpenFile = fn
  }

  showStatic(data: TapestryResponse, _title: string, assetBase = './data/claims'): void {
    this.disposed = false
    this.clearHideCleanupTimeout()
    this.clearDataRequest()
    this.clearPreloadCache()

    this.staticMode = true
    this.staticAssetBase = assetBase
    this.staticDataBase = assetBase.replace(/\/[^/]+\/claims$/, '')
    this.staticFileModal = new TapestryStaticFileModal(this.staticDataBase)
    this.tapestryData = data
    this.selectedNodeId = null

    this.annotations.hidePanel()
    this.annotationPanelEl.style.display = 'none'
    this.closeBtn.style.display = 'none'
    this.loadingIndicator.style.display = 'none'
    this.dagContainer.innerHTML = ''

    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
    this.panel.classList.add('visible')

    this.graph.render(data)
    this.renderFiberList()
    this.selectFromHash()
  }

  private pushHash(id: string | null): void {
    const current = window.location.hash.slice(1)
    if (id === current) return
    if (id) {
      window.history.pushState(null, '', `#${id}`)
    } else {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  selectFromHash(): void {
    const hash = window.location.hash.slice(1)
    if (!hash || !this.tapestryData) return
    const node = this.tapestryData.nodes.find((candidate) => candidate.id === hash)
    if (node) {
      this.graph.revealAndSelect(hash, false, true)
      return
    }
    if (this.tapestryData.fibers?.find((fiber) => fiber.id === hash)) {
      this.selectFiber(hash)
    }
  }

  private artifactUrl(specName: string, filePath: string): string {
    const filename = filePath.split('/').pop() || ''
    if (this.staticMode) {
      return `${this.staticAssetBase}/${encodeURIComponent(specName)}/${encodeURIComponent(filename)}`
    }
    return `${API_BASE}/tapestry-asset/${encodeURIComponent(specName)}/${encodeURIComponent(filename)}?cityId=${encodeURIComponent(this.currentCity?.id || '')}`
  }

  private handleGraphSelection(id: string): void {
    this.selectedNodeId = id
    this.detailPanelController.renderNode(id)
    this.preloadNeighborArtifacts(id)
    if (!this.staticMode) void this.annotations.load(id)
    this.pushHash(id)
  }

  private clearPreloadCache(): void {
    for (const img of this.preloadCache.values()) {
      img.onload = null
      img.onerror = null
      img.src = ''
    }
    this.preloadCache.clear()
  }

  private touchPreload(url: string): boolean {
    const existing = this.preloadCache.get(url)
    if (!existing) return false
    this.preloadCache.delete(url)
    this.preloadCache.set(url, existing)
    return true
  }

  private prunePreloadCache(): void {
    while (this.preloadCache.size > PRELOAD_CACHE_LIMIT) {
      const oldestKey = this.preloadCache.keys().next().value as string | undefined
      if (!oldestKey) return
      const img = this.preloadCache.get(oldestKey)
      if (img) {
        img.onload = null
        img.onerror = null
        img.src = ''
      }
      this.preloadCache.delete(oldestKey)
    }
  }

  private preloadNeighborArtifacts(nodeId: string): void {
    if (!this.tapestryData) return
    const node = this.tapestryData.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return

    const neighborIds = new Set<string>()
    node.dependsOn.forEach((id) => neighborIds.add(id))
    const downstream = this.tapestryData.downstream[nodeId] || []
    downstream.forEach((candidate) => neighborIds.add(candidate.id))

    for (const neighborId of neighborIds) {
      const neighbor = this.tapestryData.nodes.find((candidate) => candidate.id === neighborId)
      if (!neighbor?.evidence?.artifacts) continue
      const entries = artifactEntries(neighbor.evidence.artifacts)
      if (entries.length === 0) continue
      const firstImage = entries.find(([, path]) => !isPdfArtifact(path))
      if (!firstImage) continue
      const [, path] = firstImage
      const url = this.artifactUrl(neighbor.specName || '', path)
      if (this.touchPreload(url)) continue
      const img = new Image()
      img.src = url
      this.preloadCache.set(url, img)
      this.prunePreloadCache()
    }
  }

  private async refreshCurrentNode(): Promise<void> {
    if (!this.currentCity) return
    const selectedId = this.selectedNodeId

    const { requestId, signal } = this.beginDataRequest()
    try {
      const response = await fetch(`${API_BASE}/tapestry?cityId=${encodeURIComponent(this.currentCity.id)}`, { signal })
      if (!response.ok) throw new Error(await response.text())
      const data = await response.json()
      if (!this.isCurrentDataRequest(requestId)) return
      this.tapestryData = data
      this.graph.render(data)
      this.renderFiberList()

      if (selectedId) {
        const node = this.tapestryData?.nodes.find((candidate) => candidate.id === selectedId)
        if (node) {
          this.graph.selectNode(selectedId)
        }
      }

      showToast('Refreshed', 'success', 1500)
    } catch (err) {
      if (!this.isCurrentDataRequest(requestId)) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      showToast('Refresh failed', 'error')
      console.error('Tapestry refresh failed:', err)
    } finally {
      if (this.isCurrentDataRequest(requestId)) {
        this.dataFetchAbortController = null
      }
    }
  }

  private renderDetailBody(container: HTMLElement, body: string): void {
    this.detailBody.render({
      container,
      body,
      city: this.currentCity,
      interpolateConfig: (bodyEl) => this.interpolateConfig(bodyEl),
      openFileFromLink: (path, line) => this.openFileFromLink(path, line),
    })
  }

  private enterBodyEditMode(node: TapestryNode): void {
    if (!node.body || !this.currentCity) return
    const bodyEl = this.detailPanel.querySelector('.tapestry-detail-body') as HTMLElement | null
    if (!bodyEl) return

    this.detailBody.enterEditMode({
      container: bodyEl,
      node,
      city: this.currentCity,
      onSave: () => { void this.saveBodyAndExit(node) },
    })
  }

  private async saveBodyAndExit(node: TapestryNode): Promise<void> {
    if (!this.currentCity) return
    const newContent = await this.detailBody.save(node, this.currentCity)
    if (newContent === null) return
    node.body = newContent
    this.exitBodyEditMode(node)
  }

  private exitBodyEditMode(node: TapestryNode): void {
    this.detailBody.destroy()
    this.detailPanelController.exitBodyEditMode(node)
  }

  private cleanupDetailBindings(): void {
    this.detailPanelController.destroy()
  }

  private hideDetail(skipGraphReset = false): void {
    this.cleanupDetailBindings()
    this.lightbox.close()
    this.detailBody.destroy()
    this.detailPanelController.hide()
    this.selectedNodeId = null
    this.pushHash(null)
    if (!this.staticMode) this.annotations.hidePanel()
    this.panel.querySelector('.tapestry-ann-popover')?.remove()
    if (!skipGraphReset) this.graph.clearSelection()
  }

  private navigateToFiber(fiberId: string): void {
    if (!this.tapestryData) return
    const dagNode = this.tapestryData.nodes.find((node) => node.id === fiberId)
    if (dagNode) {
      this.graph.selectNode(fiberId, true)
      return
    }
    if (this.tapestryData.fibers?.find((fiber) => fiber.id === fiberId)) {
      this.selectFiber(fiberId)
      return
    }
    this.openFileFromLink(`.felt/${fiberId}.md`)
  }

  private openFileFromLink(href: string, line?: number): void {
    if (this.staticMode) {
      this.staticFileModal?.open(href, line)
      return
    }
    if (!this.onOpenFile || !this.currentCity) return
    const path = href.startsWith('/') ? href : `${this.currentCity.path}/${href}`
    this.onOpenFile(path, this.currentCity, line)
  }

  private interpolateConfig(container: HTMLElement): void {
    const config = this.tapestryData?.config
    if (!config) return
    interpolateConfig(container, config)
  }

  private renderFiberList(): void {
    if (!this.tapestryData) return
    const fibers = this.tapestryData.fibers || []
    const query = this.fiberSearchInput.value.toLowerCase().trim()
    const filtered = query
      ? fibers.filter((fiber) => {
          const text = [fiber.title, fiber.body, fiber.kind, fiber.id, fiber.outcome, ...(fiber.tags || [])]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          return text.includes(query)
        })
      : fibers

    const isRule = (fiber: TapestryFiber) => fiber.tags?.some((tag) => tag.startsWith('tapestry:')) ?? false
    const stalenessOrder: Record<string, number> = { stale: 0, 'no-evidence': 1, fresh: 2 }
    const statusOrder: Record<string, number> = { active: 0, open: 1, untracked: 2, closed: 3 }

    const sorted = [...filtered].sort((a, b) => {
      const aRule = isRule(a) ? 0 : 1
      const bRule = isRule(b) ? 0 : 1
      if (aRule !== bRule) return aRule - bRule
      if (aRule === 0 && bRule === 0) {
        const aDag = this.tapestryData!.nodes.find((node) => node.id === a.id)
        const bDag = this.tapestryData!.nodes.find((node) => node.id === b.id)
        const aStaleness = stalenessOrder[aDag?.staleness || 'no-evidence'] ?? 1
        const bStaleness = stalenessOrder[bDag?.staleness || 'no-evidence'] ?? 1
        if (aStaleness !== bStaleness) return aStaleness - bStaleness
      }
      const aStatus = statusOrder[a.status] ?? 2
      const bStatus = statusOrder[b.status] ?? 2
      if (aStatus !== bStatus) return aStatus - bStatus
      return a.title.localeCompare(b.title)
    })

    this.fiberResultsEl.innerHTML = sorted.map((fiber) => {
      const dagNode = this.tapestryData!.nodes.find((node) => node.id === fiber.id)
      const ruleTag = isRule(fiber)
      const dotColor = dagNode ? stalenessColor(dagNode.staleness) : '#7A7368'
      const dotIcon = statusIcon(fiber.status)
      const nonRuleTags = (fiber.tags || []).filter((tag) => !tag.startsWith('tapestry:'))
      const tagsHtml = nonRuleTags.map((tag) =>
        `<span class="fiber-tag">${escapeHtml(tag.replace(/^\[|\]$/g, ''))}</span>`
      ).join('')
      const kindBadge = fiber.kind !== 'task' ? `<span class="fiber-kind">${escapeHtml(fiber.kind)}</span>` : ''
      const ruleClass = ruleTag ? ' fiber-item-rule' : ''
      return `<div class="fiber-item${ruleClass}" data-fiber-id="${escapeHtml(fiber.id)}">
        <span class="fiber-dot" style="color: ${dotColor}">${dotIcon}</span>
        <span class="fiber-title">${escapeHtml(shortName(fiber.title))}</span>
        ${tagsHtml}${kindBadge}
      </div>`
    }).join('')

    this.fiberResultsEl.querySelectorAll('.fiber-item').forEach((el) => {
      el.addEventListener('click', () => {
        const fiberId = (el as HTMLElement).dataset.fiberId
        if (!fiberId) return
        if (this.tapestryData?.nodes.find((node) => node.id === fiberId)) {
          this.graph.selectNode(fiberId)
        } else {
          this.selectFiber(fiberId)
        }
      })
    })
  }

  private selectFiber(fiberId: string): void {
    this.selectedNodeId = fiberId
    this.pushHash(fiberId)
    this.detailBody.destroy()
    this.detailPanelController.renderFiber(fiberId)
  }

  private handleSearch(): void {
    const query = this.fiberSearchInput.value.toLowerCase().trim()
    this.clearSearchHighlights()
    this.searchResults.innerHTML = ''
    this.searchFocusIdx = -1

    if (!query || !this.tapestryData) return

    const matches: Array<{ node: TapestryNode; context: string }> = []
    this.tapestryData.nodes.forEach((node) => {
      const searchText = [node.title, node.body, node.kind, node.id].filter(Boolean).join(' ').toLowerCase()
      if (!searchText.includes(query)) return
      const idx = searchText.indexOf(query)
      const start = Math.max(0, idx - SEARCH_SNIPPET_CONTEXT)
      const end = Math.min(searchText.length, idx + query.length + SEARCH_SNIPPET_CONTEXT)
      let snippet = searchText.substring(start, end)
      if (start > 0) snippet = '...' + snippet
      if (end < searchText.length) snippet += '...'
      matches.push({ node, context: snippet })
    })

    this.graph.setSearchMatches(new Set(matches.map((match) => match.node.id)))

    if (matches.length === 0) {
      this.searchResults.innerHTML = '<div class="search-no-results">no matches</div>'
      return
    }

    matches.forEach((match) => {
      const color = stalenessColor(match.node.staleness)
      const div = document.createElement('div')
      div.className = 'search-result'
      div.innerHTML = `
        <span class="search-result-dot" style="background: ${color}"></span>
        <span class="search-result-name">${escapeHtml(shortName(match.node.title))}</span>
        <span class="search-result-match">${escapeHtml(match.context)}</span>
      `
      div.addEventListener('click', () => {
        this.graph.revealAndSelect(match.node.id, true, true)
        this.fiberSearchInput.value = ''
        this.searchResults.innerHTML = ''
        this.clearSearchHighlights()
        this.searchFocusIdx = -1
        this.renderFiberList()
      })
      this.searchResults.appendChild(div)
    })
  }

  private clearSearchHighlights(): void {
    this.graph.setSearchMatches(new Set())
  }

  private updateSearchFocus(): void {
    const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
    results.forEach((result, index) => result.classList.toggle('search-focused', index === this.searchFocusIdx))
    if (this.searchFocusIdx >= 0 && this.searchFocusIdx < results.length) {
      results[this.searchFocusIdx].scrollIntoView({ block: 'nearest' })
    }
  }

  private promptImageAnnotation(
    node: TapestryNode,
    artifactName: string,
    x: number,
    y: number,
  ): void {
    this.annotations.promptImageAnnotation(node, artifactName, x, y)
  }
}
