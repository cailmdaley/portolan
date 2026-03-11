// TapestryView — native DAG visualization for fibers.

import type { City } from '../state/types'
import { AnnotationPanel } from './AnnotationPanel'
import { TapestryArtifactLightbox } from './TapestryArtifactLightbox'
import { TapestryClaimsAnnotations } from './TapestryClaimsAnnotations'
import { TapestryDagGraph } from './TapestryDagGraph'
import { TapestryDetailBody } from './TapestryDetailBody'
import { TapestryDetailPanel } from './TapestryDetailPanel'
import { TapestrySidebar } from './TapestrySidebar'
import { TapestryViewRuntime } from './TapestryViewRuntime'
import type { TapestryNode, TapestryResponse } from './tapestry-types'
import { interpolateConfig, showToast } from './utils'
import { type WorkerInfo } from './WorkerPicker'

export type { TapestryResponse } from './tapestry-types'

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
  private sidebar: TapestrySidebar
  private runtime = new TapestryViewRuntime()
  private hideCleanupTimeout: ReturnType<typeof setTimeout> | null = null
  private lightbox = new TapestryArtifactLightbox(
    (specName, filePath) => this.runtime.artifactUrl(specName, filePath),
    (node, artifactName, x, y) => this.promptImageAnnotation(node, artifactName, x, y),
    () => this.runtime.isStaticMode(),
  )
  private detailBody = new TapestryDetailBody()

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
      getCurrentCity: () => this.runtime.getCurrentCity(),
      getSelectedNodeId: () => this.runtime.getSelectedNodeId(),
      getSelectedNode: () => {
        const data = this.runtime.getTapestryData()
        const selectedNodeId = this.runtime.getSelectedNodeId()
        if (!data || !selectedNodeId) return null
        return data.nodes.find((node) => node.id === selectedNodeId) || null
      },
      getDetailBodyElement: () => this.detailPanel.querySelector('.tapestry-detail-body'),
      getWorkers: () => {
        const city = this.runtime.getCurrentCity()
        if (!city || !this.onGetWorkers) return []
        return this.onGetWorkers(city)
      },
    })
    this.detailPanelController = new TapestryDetailPanel({
      panel: this.panel,
      detailPanel: this.detailPanel,
      fiberListEl: this.fiberListEl,
      getCurrentCity: () => this.runtime.getCurrentCity(),
      getTapestryData: () => this.runtime.getTapestryData(),
      isStaticMode: () => this.runtime.isStaticMode(),
      getArtifactUrl: (specName, filePath) => this.runtime.artifactUrl(specName, filePath),
      openStaticFile: (href, line) => this.runtime.openStaticFile(href, line),
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
    this.sidebar = new TapestrySidebar({
      searchInput: this.fiberSearchInput,
      searchResults: this.searchResults,
      fiberResultsEl: this.fiberResultsEl,
      getData: () => this.runtime.getTapestryData(),
      setSearchMatches: (matches) => this.graph.setSearchMatches(matches),
      selectListedNode: (fiberId) => this.graph.selectNode(fiberId),
      selectSearchNode: (fiberId) => this.graph.revealAndSelect(fiberId, true, true),
      selectFiber: (fiberId) => this.selectFiber(fiberId),
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
        const node = this.runtime.getTapestryData()?.nodes.find((candidate) => candidate.id === this.detailBody.getEditingNodeId())
        if (node) this.exitBodyEditMode(node)
        return
      }
      if (this.detailPanel.classList.contains('hidden')) {
        this.hide()
      } else {
        this.hideDetail()
      }
    }

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
      if (this.runtime.isStaticMode()) return
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

  private clearHideCleanupTimeout(): void {
    if (this.hideCleanupTimeout) {
      clearTimeout(this.hideCleanupTimeout)
      this.hideCleanupTimeout = null
    }
  }

  async show(city: City): Promise<void> {
    this.clearHideCleanupTimeout()
    this.sidebar.reset()
    this.annotations.hidePanel()
    this.annotations.reset()
    this.hideDetail()

    this.loadingIndicator.style.display = 'flex'
    this.loadingIndicator.textContent = 'Loading tapestry\u2026'
    this.loadingIndicator.classList.remove('error')
    this.dagContainer.innerHTML = ''

    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
    this.panel.classList.add('visible')

    try {
      const data = await this.runtime.showCity(city)
      this.loadingIndicator.style.display = 'none'
      this.graph.render(data)
      this.sidebar.renderFiberList()
      this.selectFromHash()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      this.loadingIndicator.textContent = 'Failed to load tapestry'
      this.loadingIndicator.classList.add('error')
      console.error('Tapestry fetch failed:', err)
    }
  }

  hide(): void {
    this.clearHideCleanupTimeout()
    this.hideDetail(true)
    this.graph.clear()
    this.runtime.hide()

    this.panel.classList.remove('visible')
    this.panel.querySelector('.tapestry-ann-popover')?.remove()
    this.annotations.reset()
    this.sidebar.reset()

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
    const runtimeStats = this.runtime.getRuntimeStats()
    return {
      visible: this.isVisible(),
      disposed: runtimeStats.disposed,
      staticMode: runtimeStats.staticMode,
      currentCityId: runtimeStats.currentCityId,
      selectedNodeId: runtimeStats.selectedNodeId,
      expandedNodeCount: graphStats.expandedNodeCount,
      visibleNodeCount: graphStats.visibleNodeCount,
      hasSimulation: graphStats.hasSimulation,
      hasSvg: graphStats.hasSvg,
      hasZoomBehavior: graphStats.hasZoomBehavior,
      preloadCacheSize: runtimeStats.preloadCacheSize,
      transientFrameCount: graphStats.transientFrameCount,
      hasDataFetchRequest: runtimeStats.hasDataFetchRequest,
      dataRequestId: runtimeStats.dataRequestId,
      hasHideCleanupTimeout: this.hideCleanupTimeout !== null,
      hasEscapeHandler: this.escapeHandler !== null,
      hasArtifactClickHandler: this.detailPanelController.getRuntimeStats().hasArtifactClickHandler,
      hasGalleryDetach: this.detailPanelController.getRuntimeStats().hasGalleryDetach,
      hasStaticFileModal: runtimeStats.hasStaticFileModal,
      hasStaticFileModalKeyHandler: runtimeStats.hasStaticFileModalKeyHandler,
      hasLightboxCleanup: this.lightbox.isOpen(),
      hasTooltip: graphStats.hasTooltip,
    }
  }

  dispose(): void {
    this.runtime.dispose()
    this.hide()
    this.clearHideCleanupTimeout()
    this.detailPanelController.destroy()
    this.sidebar.destroy()
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
    this.clearHideCleanupTimeout()
    this.runtime.showStatic(data, assetBase)
    this.sidebar.reset()

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
    this.sidebar.renderFiberList()
    this.selectFromHash()
  }

  selectFromHash(): void {
    this.runtime.selectFromHash(
      (fiberId) => this.graph.revealAndSelect(fiberId, false, true),
      (fiberId) => this.selectFiber(fiberId),
    )
  }

  private handleGraphSelection(id: string): void {
    this.runtime.setSelectedNodeId(id)
    this.detailPanelController.renderNode(id)
    this.runtime.preloadNeighborArtifacts(id)
    if (!this.runtime.isStaticMode()) void this.annotations.load(id)
    this.runtime.pushHash(id)
  }

  private async refreshCurrentNode(): Promise<void> {
    if (!this.runtime.getCurrentCity()) return
    const selectedId = this.runtime.getSelectedNodeId()
    try {
      const data = await this.runtime.refresh()
      if (!data) return
      this.graph.render(data)
      this.sidebar.renderFiberList()

      if (selectedId) {
        const node = this.runtime.getTapestryData()?.nodes.find((candidate) => candidate.id === selectedId)
        if (node) {
          this.graph.selectNode(selectedId)
        }
      }

      showToast('Refreshed', 'success', 1500)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      showToast('Refresh failed', 'error')
      console.error('Tapestry refresh failed:', err)
    }
  }

  private renderDetailBody(container: HTMLElement, body: string): void {
    this.detailBody.render({
      container,
      body,
      city: this.runtime.getCurrentCity(),
      interpolateConfig: (bodyEl) => this.interpolateConfig(bodyEl),
      openFileFromLink: (path, line) => this.openFileFromLink(path, line),
    })
  }

  private enterBodyEditMode(node: TapestryNode): void {
    const city = this.runtime.getCurrentCity()
    if (!node.body || !city) return
    const bodyEl = this.detailPanel.querySelector('.tapestry-detail-body') as HTMLElement | null
    if (!bodyEl) return

    this.detailBody.enterEditMode({
      container: bodyEl,
      node,
      city,
      onSave: () => { void this.saveBodyAndExit(node) },
    })
  }

  private async saveBodyAndExit(node: TapestryNode): Promise<void> {
    const city = this.runtime.getCurrentCity()
    if (!city) return
    const newContent = await this.detailBody.save(node, city)
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
    this.runtime.setSelectedNodeId(null)
    this.runtime.pushHash(null)
    if (!this.runtime.isStaticMode()) this.annotations.hidePanel()
    this.panel.querySelector('.tapestry-ann-popover')?.remove()
    if (!skipGraphReset) this.graph.clearSelection()
  }

  private navigateToFiber(fiberId: string): void {
    const data = this.runtime.getTapestryData()
    if (!data) return
    const dagNode = data.nodes.find((node) => node.id === fiberId)
    if (dagNode) {
      this.graph.selectNode(fiberId, true)
      return
    }
    if (data.fibers?.find((fiber) => fiber.id === fiberId)) {
      this.selectFiber(fiberId)
      return
    }
    this.openFileFromLink(`.felt/${fiberId}.md`)
  }

  private openFileFromLink(href: string, line?: number): void {
    if (this.runtime.isStaticMode()) {
      this.runtime.openStaticFile(href, line)
      return
    }
    const city = this.runtime.getCurrentCity()
    if (!this.onOpenFile || !city) return
    const path = href.startsWith('/') ? href : `${city.path}/${href}`
    this.onOpenFile(path, city, line)
  }

  private interpolateConfig(container: HTMLElement): void {
    const config = this.runtime.getTapestryData()?.config
    if (!config) return
    interpolateConfig(container, config)
  }

  private selectFiber(fiberId: string): void {
    this.runtime.setSelectedNodeId(fiberId)
    this.runtime.pushHash(fiberId)
    this.detailBody.destroy()
    this.detailPanelController.renderFiber(fiberId)
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
