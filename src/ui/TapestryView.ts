// TapestryView — native DAG visualization for fibers.

import * as d3Force from 'd3-force'
import * as d3Selection from 'd3-selection'
import * as d3Drag from 'd3-drag'
import * as d3Zoom from 'd3-zoom'
import 'd3-transition'
import { easeCubicInOut } from 'd3-ease'
import type { City } from '../state/types'
import { escapeHtml, interpolateConfig, showToast } from './utils'
import { type WorkerInfo } from './WorkerPicker'
import { AnnotationPanel } from './AnnotationPanel'
import type { TapestryNode, TapestryFiber, TapestryResponse, SimNode, SimLink, SVGPathSelection, EdgeDatum } from './tapestry-types'
import { TapestryStaticFileModal } from './TapestryStaticFileModal'
import { TapestryArtifactLightbox } from './TapestryArtifactLightbox'
import { TapestryDetailBody } from './TapestryDetailBody'
import { TapestryDetailPanel } from './TapestryDetailPanel'
import { TapestryClaimsAnnotations } from './TapestryClaimsAnnotations'
import {
  NODE_RX, NODE_RY, INTERIOR_DEPTH_NUDGE, RING_SCALES, RING_COUNT, SIMULATION_TICKS,
  stalenessColor, dotStalenessColor, statusIcon, isSectionNode,
  artifactEntries, isPdfArtifact,
  hashString, seededRandom, organicEllipse, ringOpacity, ellipsePoint,
  shortName, leadParagraph, splitNeighborFibers,
} from './tapestry-helpers'

export type { TapestryResponse } from './tapestry-types'

const API_BASE = `http://${window.location.hostname}:4004`

const PRELOAD_CACHE_LIMIT = 64
const SEARCH_SNIPPET_CONTEXT = 15

// ── TapestryView ──────────────────────────────────────────────────────

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
  private annotations: TapestryClaimsAnnotations
  private detailPanelController: TapestryDetailPanel

  private currentCity: City | null = null
  private tapestryData: TapestryResponse | null = null
  private selectedNodeId: string | null = null
  private staticMode = false
  private staticAssetBase = ''
  private staticDataBase = ''
  private simulation: d3Force.Simulation<SimNode, SimLink> | null = null
  private svgEl: d3Selection.Selection<SVGSVGElement, unknown, null, undefined> | null = null
  private zoomBehavior: d3Zoom.ZoomBehavior<SVGSVGElement, unknown> | null = null
  private expandedNodes = new Set<string>()
  private visibleNodes = new Set<string>()  // tracks which nodes are fully visible (for animation)
  private searchFocusIdx = -1
  private flutterRAF: number | null = null
  private flutterTick: (() => void) | null = null
  private preloadCache = new Map<string, HTMLImageElement>()
  private hideCleanupTimeout: ReturnType<typeof setTimeout> | null = null
  private dataFetchAbortController: AbortController | null = null
  private dataRequestId = 0
  private transientFrameIds = new Set<number>()
  private staticFileModal: TapestryStaticFileModal | null = null
  private lightbox = new TapestryArtifactLightbox(
    (specName, filePath) => this.artifactUrl(specName, filePath),
    (node, artifactName, x, y) => this.promptImageAnnotation(node, artifactName, x, y),
    () => this.staticMode,
  )
  private detailBody = new TapestryDetailBody()
  private disposed = false

  // HMR-safe listener refs
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private onGetWorkers: ((city: City) => WorkerInfo[]) | null = null
  private onOpenFile: ((path: string, city: City, line?: number) => void) | null = null

  // Hover tooltip
  private tooltip: HTMLElement | null = null

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
    this.annotations = new TapestryClaimsAnnotations({
      panelEl: this.annotationPanelEl,
      getContainer: () => this.panel,
      getCurrentCity: () => this.currentCity,
      getSelectedNodeId: () => this.selectedNodeId,
      getSelectedNode: () => {
        if (!this.tapestryData || !this.selectedNodeId) return null
        return this.tapestryData.nodes.find(node => node.id === this.selectedNodeId) || null
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

    // Create floating tooltip element
    this.tooltip = document.createElement('div')
    this.tooltip.className = 'tapestry-hover-tooltip'
    document.body.appendChild(this.tooltip)
  }

  // ── DOM construction ───────────────────────────────────────────────

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
      if (e.key === 'Escape' && this.isVisible()) {
        // If editing body, exit edit mode (discard changes)
        if (this.detailBody.isEditing()) {
          const node = this.tapestryData?.nodes.find(n => n.id === this.detailBody.getEditingNodeId())
          if (node) this.exitBodyEditMode(node)
          return
        }
        if (this.detailPanel.classList.contains('hidden')) {
          this.hide()
        } else {
          this.hideDetail()
        }
      }
    }

    // Search (fiber sidebar)
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
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
        if (results.length === 0) return
        if (e.key === 'ArrowDown') {
          this.searchFocusIdx = (this.searchFocusIdx + 1) % results.length
        } else {
          this.searchFocusIdx = this.searchFocusIdx <= 0 ? results.length - 1 : this.searchFocusIdx - 1
        }
        this.updateSearchFocus()
      } else if (e.key === 'Enter') {
        const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
        if (this.searchFocusIdx >= 0 && this.searchFocusIdx < results.length) {
          results[this.searchFocusIdx].click()
        }
      }
    })

    // Sidebar resize (only active when expanded)
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

    // Text selection for annotation (disabled in static mode)
    // Delay mouseup handler to distinguish single-click selection from double-click (edit mode)
    let selectionTimeout: ReturnType<typeof setTimeout> | null = null
    this.detailPanel.addEventListener('mouseup', () => {
      if (this.staticMode) return
      // Wait briefly — if a dblclick follows, it will cancel this
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

  private requestTransientFrame(callback: FrameRequestCallback): number {
    const frameId = requestAnimationFrame((timestamp) => {
      this.transientFrameIds.delete(frameId)
      callback(timestamp)
    })
    this.transientFrameIds.add(frameId)
    return frameId
  }

  private cancelTransientFrames(): void {
    for (const frameId of this.transientFrameIds) {
      cancelAnimationFrame(frameId)
    }
    this.transientFrameIds.clear()
  }

  private cleanupDetailBindings(): void {
    this.detailPanelController.destroy()
  }

  // ── Public API ─────────────────────────────────────────────────────

  async show(city: City): Promise<void> {
    this.disposed = false
    this.clearHideCleanupTimeout()
    this.clearPreloadCache()

    this.currentCity = city
    this.selectedNodeId = null
    this.expandedNodes.clear()
    this.visibleNodes.clear()

    // Save the incoming hash before hideDetail() clears it
    const incomingHash = window.location.hash

    this.annotations.hidePanel()
    this.annotations.reset()
    this.hideDetail()

    // Persist city in URL (and restore hash that hideDetail cleared)
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
      this.renderDAG()
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
    this.cancelTransientFrames()
    this.hideDetail(true)
    this.staticFileModal?.close()
    this.clearPreloadCache()

    this.panel.classList.remove('visible')
    this.panel.querySelector('.tapestry-ann-popover')?.remove()
    if (this.tooltip) this.tooltip.style.display = 'none'

    // Clear city from URL
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

    if (this.simulation) {
      this.simulation.stop()
      this.simulation = null
    }

    this.stopFlutter()

    this.hideCleanupTimeout = setTimeout(() => {
      if (!this.isVisible()) {
        this.dagContainer.innerHTML = ''
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
    return {
      visible: this.isVisible(),
      disposed: this.disposed,
      staticMode: this.staticMode,
      currentCityId: this.currentCity?.id ?? null,
      selectedNodeId: this.selectedNodeId,
      expandedNodeCount: this.expandedNodes.size,
      visibleNodeCount: this.visibleNodes.size,
      hasSimulation: this.simulation !== null,
      hasSvg: this.svgEl !== null,
      hasZoomBehavior: this.zoomBehavior !== null,
      preloadCacheSize: this.preloadCache.size,
      transientFrameCount: this.transientFrameIds.size,
      hasDataFetchRequest: this.dataFetchAbortController !== null,
      dataRequestId: this.dataRequestId,
      hasHideCleanupTimeout: this.hideCleanupTimeout !== null,
      hasEscapeHandler: this.escapeHandler !== null,
      hasArtifactClickHandler: this.detailPanelController.getRuntimeStats().hasArtifactClickHandler,
      hasGalleryDetach: this.detailPanelController.getRuntimeStats().hasGalleryDetach,
      hasStaticFileModal: this.staticFileModal?.isOpen() ?? false,
      hasStaticFileModalKeyHandler: this.staticFileModal?.isOpen() ?? false,
      hasLightboxCleanup: this.lightbox.isOpen(),
      hasTooltip: this.tooltip !== null,
    }
  }

  dispose(): void {
    this.disposed = true
    this.hide()
    this.clearHideCleanupTimeout()
    this.detailPanelController.destroy()
    this.staticFileModal?.close()
    if (this.tooltip) {
      this.tooltip.remove()
      this.tooltip = null
    }
    this.panel.remove()
  }

  setOnGetWorkers(fn: (city: City) => WorkerInfo[]): void {
    this.onGetWorkers = fn
  }

  setOnOpenFile(fn: (path: string, city: City, line?: number) => void): void {
    this.onOpenFile = fn
  }

  /** Render a static (server-less) view from pre-baked data. */
  showStatic(data: TapestryResponse, _title: string, assetBase = './data/claims'): void {
    this.disposed = false
    this.clearHideCleanupTimeout()
    this.clearDataRequest()
    this.clearPreloadCache()

    this.staticMode = true
    this.staticAssetBase = assetBase
    // Derive data base from asset base: /tapestries/data/city/claims → /tapestries/data
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

    this.renderDAG()
    this.renderFiberList()
    this.selectFromHash()
  }

  // ── URL hash for shareable links ──────────────────────────────────

  private pushHash(id: string | null): void {
    const current = window.location.hash.slice(1)
    if (id === current) return
    if (id) {
      window.history.pushState(null, '', `#${id}`)
    } else {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  /** Select a node/fiber from the current URL hash, if any. */
  selectFromHash(): void {
    const hash = window.location.hash.slice(1)
    if (!hash || !this.tapestryData) return

    // Try DAG node first, then sidebar fiber
    const node = this.tapestryData.nodes.find(n => n.id === hash)
    if (node) {
      // Reveal fog neighborhood without animation (page load — no wave), but center
      this.revealAndSelect(hash, false, true)
      return
    }

    const fiber = this.tapestryData.fibers?.find(f => f.id === hash)
    if (fiber) {
      this.selectFiber(hash)
    }
  }

  /** Build an artifact image URL, using local paths in static mode. */
  private artifactUrl(specName: string, filePath: string): string {
    const filename = filePath.split('/').pop() || ''
    if (this.staticMode) {
      return `${this.staticAssetBase}/${encodeURIComponent(specName)}/${encodeURIComponent(filename)}`
    }
    return `${API_BASE}/tapestry-asset/${encodeURIComponent(specName)}/${encodeURIComponent(filename)}?cityId=${encodeURIComponent(this.currentCity?.id || '')}`
  }

  // ── DAG rendering ──────────────────────────────────────────────────

  private renderDAG(): void {
    if (!this.tapestryData) return
    this.cancelTransientFrames()

    const { nodes: rawNodes, links: rawLinks } = this.tapestryData
    if (rawNodes.length === 0) {
      this.dagContainer.innerHTML = '<div class="tapestry-empty">No tapestry: fibers found</div>'
      return
    }

    const containerRect = this.dagContainer.getBoundingClientRect()
    const width = Math.max(containerRect.width || 800, 800)
    const height = Math.max(containerRect.height || 600, 600)

    // Compute DAG depth for each node (used for section ordering and display)
    const depthMap = new Map<string, number>()
    const nodeMap = new Map(rawNodes.map(n => [n.id, n]))

    function computeDepth(id: string, visited = new Set<string>()): number {
      if (depthMap.has(id)) return depthMap.get(id)!
      if (visited.has(id)) return 0
      visited.add(id)
      const node = nodeMap.get(id)
      if (!node || node.dependsOn.length === 0) {
        depthMap.set(id, 0)
        return 0
      }
      const maxDep = Math.max(...node.dependsOn.map(d => computeDepth(d, visited)))
      const depth = maxDep + 1
      depthMap.set(id, depth)
      return depth
    }

    rawNodes.forEach(n => computeDepth(n.id))

    // ── Section layout: deterministic positions by topological order ──
    // Sections are sorted by DAG depth (tie-broken by ID for determinism) and
    // assigned evenly-spaced X positions. They're pinned (fx/fy) from the start
    // so they don't move during burn-in — interior nodes settle around them.
    const hasSections = rawNodes.some(n => isSectionNode(n))
    const sectionNodesRaw = rawNodes
      .filter(n => isSectionNode(n))
      .sort((a, b) => {
        const da = depthMap.get(a.id) || 0
        const db = depthMap.get(b.id) || 0
        return da !== db ? da - db : a.id.localeCompare(b.id)
      })

    const sectionXTarget = new Map<string, number>()
    sectionNodesRaw.forEach((n, i) => {
      sectionXTarget.set(n.id, width * (i + 1) / (sectionNodesRaw.length + 1))
    })

    // Recursively find the nearest section ancestor and its depth for initial placement.
    // Returns { x: sectionX, sectionDepth } — used to compute the depth-nudge offset.
    function nearestSectionAnchor(id: string, visited = new Set<string>()): { x: number; sectionDepth: number } {
      if (visited.has(id)) return { x: width / 2, sectionDepth: 0 }
      visited.add(id)
      const node = nodeMap.get(id)
      if (!node) return { x: width / 2, sectionDepth: 0 }
      for (const depId of node.dependsOn) {
        if (sectionXTarget.has(depId)) {
          return { x: sectionXTarget.get(depId)!, sectionDepth: depthMap.get(depId) || 0 }
        }
      }
      for (const depId of node.dependsOn) {
        const anchor = nearestSectionAnchor(depId, visited)
        if (anchor.x !== width / 2) return anchor
      }
      return { x: width / 2, sectionDepth: 0 }
    }

    const simNodes: SimNode[] = rawNodes.map(n => {
      if (hasSections && isSectionNode(n)) {
        const x = sectionXTarget.get(n.id) || width / 2
        return { id: n.id, data: n, degree: 0, x, y: height / 2, fx: x, fy: height / 2 }
      }
      if (hasSections) {
        const { x: sectionX, sectionDepth } = nearestSectionAnchor(n.id)
        const nodeDepth = depthMap.get(n.id) || 0
        // Nudge each additional hop beyond the direct section neighbor rightward
        const xNudge = Math.max(0, nodeDepth - sectionDepth - 1) * INTERIOR_DEPTH_NUDGE
        return {
          id: n.id, data: n, degree: 0,
          x: sectionX + xNudge + (Math.random() - 0.5) * 50,
          y: height / 2 + (Math.random() - 0.5) * 160,
        }
      }
      return {
        id: n.id, data: n, degree: 0,
        x: width / 2 + (Math.random() - 0.5) * 200,
        y: height / 2 + (Math.random() - 0.5) * 200,
      }
    })

    const simNodeMap = new Map(simNodes.map(n => [n.id, n]))

    const simLinks: SimLink[] = rawLinks
      .map(l => ({
        source: simNodeMap.get(l.source),
        target: simNodeMap.get(l.target),
      }))
      .filter((l): l is SimLink => !!l.source && !!l.target)

    // Compute degrees
    simLinks.forEach(link => {
      link.source.degree++
      link.target.degree++
    })

    // Force simulation: sections are already pinned (fx/fy set); interior nodes
    // settle freely via link + repulsion + collide. No manual X constraints.
    this.simulation = d3Force.forceSimulation<SimNode>(simNodes)
      .force('link', d3Force.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(140)
        .strength(0.7))
      .force('charge', d3Force.forceManyBody().strength(-500).distanceMax(600))
      .force('collide', d3Force.forceCollide<SimNode>()
        .radius(d => {
          const scale = isSectionNode(d.data) ? 1.5 : 1.25
          return NODE_RX * scale + 8  // actual ellipse half-width + padding
        })
        .strength(0.9))
      .force('y', d3Force.forceY(height / 2).strength(0.02))
      .alphaDecay(0.012)
      .velocityDecay(0.75)
      .stop()

    for (let i = 0; i < SIMULATION_TICKS; i++) {
      this.simulation.tick()
    }

    // Freeze all nodes after burn-in: positions are pre-computed and stable.
    // Sections were pinned from the start; interior nodes are frozen now.
    this.simulation.force('y', null)
    this.simulation.alphaDecay(0.05)
    this.simulation.velocityDecay(0.9)
    simNodes.forEach(n => { n.fx = n.x; n.fy = n.y })

    // Center the frozen layout in the canvas so no nodes are clipped at edges.
    const pad = NODE_RX * 2
    const xs = simNodes.map(n => n.x!)
    const ys = simNodes.map(n => n.y!)
    const xOffset = (width - (Math.max(...xs) - Math.min(...xs))) / 2 - Math.min(...xs)
    const yOffset = (height - (Math.max(...ys) - Math.min(...ys))) / 2 - Math.min(...ys)
    const clampedXOffset = Math.max(xOffset, pad - Math.min(...xs))
    const clampedYOffset = Math.max(yOffset, pad - Math.min(...ys))
    simNodes.forEach(n => {
      n.x = n.x! + clampedXOffset
      n.y = n.y! + clampedYOffset
      n.fx = n.x
      n.fy = n.y
    })

    // Create SVG
    const svg = d3Selection.select(this.dagContainer)
      .append('svg')
      .attr('class', 'tapestry-svg') as d3Selection.Selection<SVGSVGElement, unknown, null, undefined>

    // SVG defs: fog blur filter for ghost nodes
    const defs = svg.append('defs')
    const fogFilter = defs.append('filter')
      .attr('id', 'fog-blur')
      .attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%')
    fogFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '2')

    // Zoom behavior
    const zoomBehavior = d3Zoom.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        rootGroup.attr('transform', event.transform)
      })

    svg.call(zoomBehavior)
    this.svgEl = svg
    this.zoomBehavior = zoomBehavior

    // Background click — collapse to skeleton view
    svg.on('click', (event) => {
      if (event.target === svg.node() || event.target.tagName === 'rect') {
        if (this.expandedNodes.size > 0) {
          this.expandedNodes.clear()
          // Don't clear visibleNodes first — let updateTierVisibility detect becomingFog
          // so collapseNodesRadial can animate them back to fog (center unused in collapse)
          this.updateTierVisibility(false, { x: 0, y: 0 })
          this.hideDetail(true)  // skip redundant updateTierVisibility — collapse animation is running
        } else {
          this.hideDetail()
        }
      }
    })

    const rootGroup = svg.append('g')

    // Draw edges
    const edgeGroup = rootGroup.append('g').attr('class', 'tapestry-edges')
    const edgePaths: SVGPathSelection[] = []

    simLinks.forEach(link => {
      const color = stalenessColor(link.target.data.staleness)
      const edgeRand = seededRandom(hashString(link.source.data.id + link.target.data.id))
      const tension = 0.35 + edgeRand() * 0.15
      // sagMagnitude: arc height as fraction of edge length (always positive).
      // sagSign is computed each tick from current angle so it adapts when nodes move.
      const sagMagnitude = edgeRand() * 0.18 + 0.06
      const edgeSeed = edgeRand()
      const wobble1 = (edgeRand() - 0.5) * 10
      const wobble2 = (edgeRand() - 0.5) * 10

      for (let s = 0; s < RING_COUNT; s++) {
        const strandOpacity = ringOpacity(s) * 0.4

        const path = edgeGroup.append('path')
          .datum({ link, strandIndex: s, tension, sagMagnitude, edgeSeed, wobble1, wobble2, sagPos: 0 })
          .attr('class', 'tapestry-link')
          .attr('stroke', color)
          .attr('stroke-width', 1)
          .attr('stroke-opacity', strandOpacity)
          .attr('stroke-linecap', 'round') as SVGPathSelection

        edgePaths.push(path)
      }
    })

    // Knockout layer — sits between edges and node visuals, always fully opaque
    // so edges are hidden behind nodes regardless of node highlighting opacity
    const knockoutGroup = rootGroup.append('g').attr('class', 'tapestry-knockouts')

    // Draw nodes
    const nodeGroup = rootGroup.append('g').attr('class', 'tapestry-nodes')
    let draggedDistance = 0
    const draggingNodes = new Set<string>()  // nodes currently held by user

    const nodeElements = nodeGroup.selectAll<SVGGElement, SimNode>('.tapestry-node')
      .data(simNodes)
      .enter()
      .append('g')
      .attr('class', 'tapestry-node')
      .call(d3Drag.drag<SVGGElement, SimNode>()
        .on('start', (event, d) => {
          draggedDistance = 0
          draggingNodes.add(d.data.id)
          if (!event.active) this.simulation?.alphaTarget(0.1).restart()
          d.fx = d.x
          d.fy = d.y
          d3Selection.select(event.sourceEvent.target.closest('.tapestry-node') as Element)
            .style('cursor', 'grabbing')
        })
        .on('drag', (event, d) => {
          draggedDistance += Math.abs(event.dx) + Math.abs(event.dy)
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          draggingNodes.delete(d.data.id)
          if (!event.active) this.simulation?.alphaTarget(0)
          // Freeze where user dropped it
          d.fx = d.x
          d.fy = d.y
          d3Selection.select(event.sourceEvent.target.closest('.tapestry-node') as Element)
            .style('cursor', 'grab')
          if (draggedDistance < 5) {
            // Click: clear hover tooltip and cancel any pending hover timer
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
            if (this.tooltip) this.tooltip.style.display = 'none'

            if (hasSections) {
              const expanding = !this.expandedNodes.has(d.data.id)
              if (expanding) {
                this.expandedNodes.add(d.data.id)
              } else {
                this.expandedNodes.delete(d.data.id)
              }
              this.updateTierVisibility(expanding, {x: d.x ?? 0, y: d.y ?? 0})
            }
            // Sidebar: click the already-selected node to deselect, otherwise select
            if (this.selectedNodeId === d.data.id) {
              this.hideDetail()
            } else {
              this.selectNode(d.data.id)
              setTimeout(() => this.centerOnNode(d.data.id), 50)
            }
          }
        }))

    // Hover: tooltip only — no reveal animation
    const HOVER_DELAY = 300
    let hoverTimer: ReturnType<typeof setTimeout> | null = null

    nodeElements
      .on('mouseenter', (event: MouseEvent, d: SimNode) => {
        const cx = event.clientX, cy = event.clientY
        hoverTimer = setTimeout(() => {
          const lead = leadParagraph(d.data.body)
          const outcome = d.data.outcome?.trim() ?? ''
          if (this.tooltip) {
            let html = `<span class="tooltip-title">${escapeHtml(d.data.title)}</span>`
            if (lead || outcome) html += '<hr class="tooltip-divider">'
            if (lead) html += `<span class="tooltip-lead">${escapeHtml(lead)}</span>`
            if (lead && outcome) html += '<hr class="tooltip-divider">'
            if (outcome) html += `<span class="tooltip-outcome">${escapeHtml(outcome)}</span>`
            this.tooltip.innerHTML = html
            this.tooltip.style.display = 'block'
            this.tooltip.style.left = `${cx + 14}px`
            this.tooltip.style.top = `${cy - 8}px`
          }
        }, HOVER_DELAY)
      })
      .on('mousemove', (event: MouseEvent) => {
        if (!this.tooltip || this.tooltip.style.display === 'none') return
        this.tooltip.style.left = `${event.clientX + 14}px`
        this.tooltip.style.top = `${event.clientY - 8}px`
      })
      .on('mouseleave', () => {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
        if (this.tooltip) this.tooltip.style.display = 'none'
      })

    // Build node visuals
    nodeElements.each((d, _i, nodes) => {
      const g = d3Selection.select(nodes[_i])
      const nodeHash = hashString(d.data.id)
      const paletteColors = ['#2E5252', '#6B3838', '#8C9090']  // verdigris, iron-gall, slate
      const color = paletteColors[nodeHash % paletteColors.length]
      const nodeSeed = nodeHash / 1000000
      const isSection = isSectionNode(d.data)
      const nodeScale = isSection && hasSections ? 1.5 : 1.25
      const rx = NODE_RX * nodeScale
      const ry = NODE_RY * nodeScale

      // Mark section nodes with a CSS class
      if (isSection) g.classed('tapestry-section-node', true)

      // Knockout in separate layer — unaffected by node group opacity changes
      knockoutGroup.append('path')
        .datum(d)
        .attr('class', 'tapestry-knockout')
        .attr('d', organicEllipse(rx, ry, nodeSeed, 1.0))
        .attr('fill', '#E8DDD0')
        .attr('fill-opacity', 1.0)
        .attr('stroke', 'none')

      // Fill layers — outer = transparent node color, inner punches with full color
      const fillColors = [color, color]
      const fillOpacities = [0.55, 0.18]
      for (let i = RING_COUNT - 1; i >= 0; i--) {
        const scale = RING_SCALES[i]
        g.append('path')
          .attr('class', 'tapestry-node-fill')
          .attr('d', organicEllipse(rx, ry, nodeSeed + i * 0.1, scale))
          .attr('fill', fillColors[i])
          .attr('fill-opacity', fillOpacities[i])
          .attr('stroke', 'none')
      }

      // Ring strokes
      for (let i = 0; i < RING_COUNT; i++) {
        const scale = RING_SCALES[i]
        const isCore = i === 0
        g.append('path')
          .attr('class', 'tapestry-node-ring')
          .attr('d', organicEllipse(rx, ry, nodeSeed + i * 0.1, scale))
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', isCore ? 0.8 : 0.5)
          .attr('stroke-opacity', ringOpacity(i) * (isCore ? 0.85 : 1))
      }

      // Label — split into 2 lines when that gives a larger font than single-line
      const name = shortName(d.data.title)
      const words = name.split(' ')
      // Sections get a wider text budget (text can extend closer to the ring edges)
      const maxTextWidth = rx * (isSection ? 2.0 : 1.7)
      const charWidth = 0.58          // em per character estimate (EB Garamond)
      const baseFs = isSection ? 19 : 14

      const fitSize = (lines: string[], base: number) => {
        const longest = Math.max(...lines.map(l => l.length))
        const needed = longest * charWidth * base
        return needed > maxTextWidth ? Math.max(7, maxTextWidth / (longest * charWidth)) : base
      }

      let lines: string[]
      let textFs: number

      if (words.length <= 1) {
        lines = [name]
        textFs = fitSize(lines, baseFs)
      } else if (words.length === 2) {
        // Try single vs split — whichever gives a noticeably larger font wins
        const fsSingle = fitSize([name], baseFs)
        const fsSplit = fitSize([words[0], words[1]], baseFs)
        lines = fsSplit > fsSingle * 1.05 ? [words[0], words[1]] : [name]
        textFs = lines.length > 1 ? fsSplit : fsSingle
      } else {
        const mid = Math.ceil(words.length / 2)
        lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
        textFs = fitSize(lines, baseFs)
      }

      const lineHeight = textFs * 1.1  // tight: 1.1× instead of ~1.4×
      if (lines.length === 1) {
        g.append('text')
          .attr('class', 'tapestry-node-label')
          .attr('y', textFs * 0.35)
          .attr('text-anchor', 'middle')
          .attr('font-size', `${textFs}px`)
          .text(lines[0])
      } else {
        g.append('text')
          .attr('class', 'tapestry-node-label')
          .attr('y', -lineHeight * 0.5 + textFs * 0.35)
          .attr('text-anchor', 'middle')
          .attr('font-size', `${textFs}px`)
          .text(lines[0])
        g.append('text')
          .attr('class', 'tapestry-node-label')
          .attr('y', lineHeight * 0.5 + textFs * 0.35)
          .attr('text-anchor', 'middle')
          .attr('font-size', `${textFs}px`)
          .text(lines[1])
      }

      // Neighbor dots — all nodes in a tiered tapestry, positioned relative to text bounds.
      if (hasSections) {
        const { upstream, downstream } = splitNeighborFibers(d.data.id, rawNodes)
        const MAX_SYMBOLS = 6
        const DOT_FS = 9
        const DOT_GAP_TOP = 0  // dots sit flush against top of text
        const DOT_GAP_BOT = 2  // slight clearance below

        // Compute text bounds (baseline-relative, SVG y is baseline)
        const ascent = textFs * 0.7, descent = textFs * 0.25
        const textTop = lines.length > 1
          ? (-lineHeight * 0.5 + textFs * 0.35) - ascent   // top of first line
          : textFs * 0.35 - ascent                          // top of single line
        const textBottom = lines.length > 1
          ? (lineHeight * 0.5 + textFs * 0.35) + descent   // bottom of last line
          : textFs * 0.35 + descent                         // bottom of single line

        // Dot strip y: bottom of upstream = textTop - GAP; top of downstream = textBottom + GAP
        const upstreamY   = textTop   - DOT_GAP_TOP - DOT_FS * 0.25
        const downstreamY = textBottom + DOT_GAP_BOT + DOT_FS * 0.7

        const renderStrip = (fibers: Array<{ id: string; staleness: TapestryNode['staleness'] }>, y: number) => {
          if (fibers.length === 0) return
          const shown = fibers.slice(0, MAX_SYMBOLS)
          const overflow = fibers.length - MAX_SYMBOLS
          const strip = g.append('text')
            .attr('y', y)
            .attr('text-anchor', 'middle')
            .attr('font-size', `${DOT_FS}px`)
            .attr('letter-spacing', '2')
          shown.forEach(f => {
            strip.append('tspan')
              .attr('fill', dotStalenessColor(f.staleness))
              .text(f.staleness === 'no-evidence' ? '○' : '●')
          })
          if (overflow > 0) {
            strip.append('tspan')
              .attr('fill', '#7A7368')
              .attr('font-size', '7px')
              .text(` +${overflow}`)
          }
        }

        renderStrip(upstream, upstreamY)
        renderStrip(downstream, downstreamY)
      }
    })

    // Update edge path positions
    const updateEdgePath = (pathEl: SVGPathSelection) => {
      const d = pathEl.datum() as EdgeDatum
      const link = d.link
      const s = d.strandIndex
      const ringScale = RING_SCALES[s]

      const spreadRange = Math.PI * 0.15
      const angleOffset = (s - 0.5) * spreadRange

      // Direction-aware: exit from the face pointing toward the target,
      // enter from the face pointing back toward the source.
      const baseAngle = Math.atan2(
        link.target.y! - link.source.y!,
        link.target.x! - link.source.x!,
      )

      const start = ellipsePoint(
        link.source.x!, link.source.y!,
        NODE_RX * ringScale, NODE_RY * ringScale,
        baseAngle + angleOffset,
      )
      const end = ellipsePoint(
        link.target.x!, link.target.y!,
        NODE_RX * ringScale, NODE_RY * ringScale,
        baseAngle + Math.PI + angleOffset,
      )

      const dx = end.x - start.x
      const dy = end.y - start.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      // Unit vector along the connection, and its perpendicular (for organic offset)
      const tx = dist > 0 ? dx / dist : 1
      const ty = dist > 0 ? dy / dist : 0
      const perpX = -ty
      const perpY = tx

      // sagSign flips with angle so curves re-curl naturally when nodes are dragged.
      // sin(angle*2 + phase) oscillates twice per rotation — each edge has a unique
      // phase (edgeSeed) so adjacent edges curl in different directions.
      const sagSign = Math.sin(baseAngle * 2 + d.edgeSeed * Math.PI * 2) >= 0 ? 1 : -1

      // Sag: snaps to geometric equilibrium when idle; lags slightly during drag (inertia).
      const targetSag = dist * d.sagMagnitude * sagSign
      const isHeld = draggingNodes.has(link.source.data.id) || draggingNodes.has(link.target.data.id)
      if (isHeld) {
        d.sagPos += (targetSag - d.sagPos) * 0.12  // smooth inertial lag while dragging
      } else {
        d.sagPos = targetSag  // immediate snap — no motion unless something is moving
      }
      const sagPos = d.sagPos

      // Compound Bézier biases:
      //   cp1 (source end) — screen gravity: source.y biases cp1 downward/upward,
      //     so edges from nodes high on screen bow upward and low nodes bow downward.
      //   cp2 (target end) — calligraphic flow: lean perpendicular to the edge direction,
      //     so horizontal edges bow up/down and vertical edges lean left/right.
      const gravityY = (link.source.y! / 200) * dist * 0.10
      const leanStrength = dist * 0.07

      const cp1 = {
        x: start.x + tx * dist * d.tension + perpX * (sagPos + d.wobble1),
        y: start.y + ty * dist * d.tension + perpY * (sagPos + d.wobble1) + gravityY,
      }
      const cp2 = {
        x: end.x - tx * dist * d.tension + perpX * (sagPos + d.wobble2) + Math.sin(baseAngle) * leanStrength,
        y: end.y - ty * dist * d.tension + perpY * (sagPos + d.wobble2) - Math.cos(baseAngle) * leanStrength,
      }

      // Node-avoidance: repel control points away from non-connected nearby nodes.
      const REPEL_RADIUS = 80
      simNodes.forEach(otherNode => {
        if (otherNode.data.id === d.link.source.data.id) return
        if (otherNode.data.id === d.link.target.data.id) return
        const ox = otherNode.x!, oy = otherNode.y!
        for (const cp of [cp1, cp2]) {
          const ddx = cp.x - ox, ddy = cp.y - oy
          const dd = Math.sqrt(ddx * ddx + ddy * ddy)
          if (dd < REPEL_RADIUS && dd > 0) {
            const strength = (REPEL_RADIUS - dd) / REPEL_RADIUS * 30
            cp.x += (ddx / dd) * strength
            cp.y += (ddy / dd) * strength
          }
        }
      })

      pathEl.attr('d', `M${start.x},${start.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${end.x},${end.y}`)
    }

    // Tick handler
    this.simulation.on('tick', () => {
      // Set viewBox on first tick only (zoom handles it after)
      if (!svg.attr('viewBox')) {
        const pad = 40
        const minNodeX = Math.min(...simNodes.map(n => n.x!)) - NODE_RX - pad
        const minNodeY = Math.min(...simNodes.map(n => n.y!)) - NODE_RY - pad
        const maxNodeX = Math.max(...simNodes.map(n => n.x!)) + NODE_RX + pad
        const maxNodeY = Math.max(...simNodes.map(n => n.y!)) + NODE_RY + pad
        svg.attr('viewBox', `${minNodeX} ${minNodeY} ${maxNodeX - minNodeX} ${maxNodeY - minNodeY}`)
      }

      nodeElements.attr('transform', d => `translate(${d.x}, ${d.y})`)
      knockoutGroup.selectAll<SVGPathElement, SimNode>('.tapestry-knockout')
        .attr('transform', d => `translate(${d.x}, ${d.y})`)
      edgePaths.forEach(path => updateEdgePath(path))
    })

    // Set initial tier visibility — skeleton view if sections exist
    if (hasSections) {
      this.expandedNodes.clear()
      this.visibleNodes.clear()
      this.updateTierVisibility()
    }

    // Gentle simulation for fine-tuning
    this.simulation.alpha(0.03).restart()

    // Wire up the RAF tick: needed for drag inertia (sagPos lerp runs per frame)
    this.flutterTick = () => {
      edgePaths.forEach(path => updateEdgePath(path))
    }
    this.startFlutter()
  }

  /**
   * Show/hide nodes and edges based on expandedNodes.
   * Sections are always visible. Any expanded node reveals its 1-hop neighborhood.
   */
  private updateTierVisibility(animate = false, center?: {x: number, y: number}): void {
    if (!this.tapestryData) return
    const allNodes = this.tapestryData.nodes
    const hasSections = allNodes.some(n => isSectionNode(n))
    if (!hasSections) return

    // Sections always visible; expanded nodes reveal their 1-hop neighborhood
    const visible = new Set<string>()
    allNodes.filter(n => isSectionNode(n)).forEach(n => visible.add(n.id))

    for (const nodeId of this.expandedNodes) {
      const node = allNodes.find(n => n.id === nodeId)
      if (!node) continue
      visible.add(nodeId)
      node.dependsOn.forEach(d => visible.add(d))
      allNodes.forEach(n => { if (n.dependsOn.includes(nodeId)) visible.add(n.id) })
    }

    // Detect newly visible and newly fogging nodes this call
    const newlyVisible = new Set<string>()
    const becomingFog = new Set<string>()
    for (const id of visible) {
      if (!this.visibleNodes.has(id)) newlyVisible.add(id)
    }
    for (const id of this.visibleNodes) {
      if (!visible.has(id)) becomingFog.add(id)
    }
    this.visibleNodes = new Set(visible)

    // Fog ghost: nodes not in visible set remain rendered but faint and non-interactive
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (d) {
      const el = d3Selection.select(this)
      if (visible.has(d.data.id)) {
        el.style('display', '')
          .style('pointer-events', '')
          .style('filter', '')
          // Newly visible nodes start transparent so they can animate in
          if (newlyVisible.has(d.data.id) && animate) {
            el.style('opacity', '0')
          }
      } else if (!becomingFog.has(d.data.id)) {
        // Already-fog nodes: set state immediately
        el.style('display', '')
          .style('opacity', '0.09')
          .style('pointer-events', '')
          .style('filter', 'url(#fog-blur)')
      }
      // becomingFog nodes: leave opacity untouched — collapseNodesRadial animates them
    })

    d3Selection.selectAll<SVGPathElement, SimNode>('.tapestry-knockout').each(function (d) {
      d3Selection.select(this).style('display', visible.has(d.data.id) ? '' : 'none')
    })

    // Edges: full display when both endpoints visible; ghost when either is in fog
    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (d) {
      const el = d3Selection.select(this)
      const srcVisible = visible.has(d.link.source.data.id)
      const tgtVisible = visible.has(d.link.target.data.id)
      const srcBecomingFog = becomingFog.has(d.link.source.data.id)
      const tgtBecomingFog = becomingFog.has(d.link.target.data.id)
      if (srcVisible && tgtVisible) {
        el.style('display', '').style('opacity', null)
      } else if (!srcBecomingFog && !tgtBecomingFog) {
        // Both already-fog: set immediately
        el.style('display', '').style('opacity', '0.04')
      }
      // Edges touching becomingFog nodes: leave for collapseNodesRadial
    })

    if (animate && newlyVisible.size > 0 && center) {
      this.revealNodesRadial(center, newlyVisible)
    }
    if (becomingFog.size > 0 && center) {
      this.collapseNodesRadial(center, becomingFog)
    }

    this.simulation?.alpha(0.05).restart()
  }

  /**
   * Animate nodes + edges emerging from fog. Wave radiates from the nearest section ancestor.
   * Node opacity is driven by its incoming edge's draw fraction — guaranteed sync regardless of
   * bezier path curvature vs euclidean distance.
   */
  private revealNodesRadial(center: {x: number, y: number}, newlyVisible: Set<string>): void {
    if (newlyVisible.size === 0 || !this.tapestryData) return

    const EXPAND_SPEED = 420  // px/s
    const ROLLOFF = 60        // px — fallback transition width for nodes with no incoming edge
    const FOG_OPACITY = 0.09
    const smoothstep = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c) }

    // BFS upstream to find nearest tier:1 ancestor — use its position as wave origin
    const nodeMap = new Map(this.tapestryData.nodes.map(n => [n.id, n]))
    const simPos = new Map<string, {x: number, y: number}>()
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(d => {
      simPos.set(d.data.id, { x: d.x ?? 0, y: d.y ?? 0 })
    })
    const nearestSection = (startId: string): {x: number, y: number} | null => {
      const queue = [startId], visited = new Set([startId])
      while (queue.length > 0) {
        const id = queue.shift()!
        const node = nodeMap.get(id)
        if (!node) continue
        if (isSectionNode(node)) return simPos.get(id) ?? null
        for (const dep of node.dependsOn) { if (!visited.has(dep)) { visited.add(dep); queue.push(dep) } }
      }
      return null
    }
    let waveOrigin = center
    for (const id of newlyVisible) {
      const pos = nearestSection(id)
      if (pos) { waveOrigin = pos; break }
    }

    // Collect newly-visible node elements (fallback: distance-based opacity for nodes with no incoming edge)
    const nodeEls = new Map<string, SVGGElement>()
    const nodeDist = new Map<string, number>()
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (d) {
      if (newlyVisible.has(d.data.id)) {
        const dx = (d.x ?? 0) - waveOrigin.x, dy = (d.y ?? 0) - waveOrigin.y
        nodeDist.set(d.data.id, Math.sqrt(dx * dx + dy * dy))
        nodeEls.set(d.data.id, this)
      }
    })

    // Edges: source→target (DAG direction). Fraction spans [dSrc, dTgt] so the edge tip
    // arrives at the target exactly when that node reaches full opacity (they share the same fraction).
    // Node opacity = max incoming edge fraction → perfect sync, immune to bezier curvature.
    interface EdgeReveal { el: SVGPathElement; startDist: number; span: number; targetId: string }
    const edgeReveals: EdgeReveal[] = []
    const nodeDrivers = new Map<string, EdgeReveal[]>()  // nodeId → edges that drive its opacity

    const visibleNodesSnap = this.visibleNodes
    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (d) {
      const srcId = d.link.source.data.id
      const tgtId = d.link.target.data.id
      // Only reveal edges where BOTH endpoints are (or will be) visible — prevents
      // edges to still-fogged nodes from showing during a partial reveal.
      if ((newlyVisible.has(srcId) || newlyVisible.has(tgtId)) && visibleNodesSnap.has(srcId) && visibleNodesSnap.has(tgtId)) {
        const dSrc = Math.sqrt(((d.link.source.x ?? 0) - waveOrigin.x) ** 2 + ((d.link.source.y ?? 0) - waveOrigin.y) ** 2)
        const dTgt = Math.sqrt(((d.link.target.x ?? 0) - waveOrigin.x) ** 2 + ((d.link.target.y ?? 0) - waveOrigin.y) ** 2)
        const L = this.getTotalLength()
        this.style.opacity = ''
        this.style.strokeDasharray = `0 ${L}`
        this.style.strokeDashoffset = '0'
        const reveal: EdgeReveal = { el: this, startDist: dSrc, span: Math.max(dTgt - dSrc, 1), targetId: tgtId }
        edgeReveals.push(reveal)
        if (newlyVisible.has(tgtId)) {
          if (!nodeDrivers.has(tgtId)) nodeDrivers.set(tgtId, [])
          nodeDrivers.get(tgtId)!.push(reveal)
        }
      }
    })

    const allDists = [...nodeDist.values(), ...edgeReveals.map(e => e.startDist + e.span)]
    const maxDist = allDists.length > 0 ? Math.max(...allDists) : 0
    const totalDuration = ((maxDist + ROLLOFF) / EXPAND_SPEED) * 1000
    const start = performance.now()

    const tick = (now: number) => {
      const waveRadius = ((now - start) / 1000) * EXPAND_SPEED

      // Edges: compute fraction and update dasharray (getTotalLength fresh — bezier shape evolves)
      const fractionOf = new Map<EdgeReveal, number>()
      for (const reveal of edgeReveals) {
        const { el, startDist, span } = reveal
        const fraction = smoothstep((waveRadius - startDist) / span)
        fractionOf.set(reveal, fraction)
        const L = el.getTotalLength()
        el.style.strokeDasharray = `${fraction * L} ${L}`
      }

      // Nodes: opacity lags behind incoming edge — starts only when edge is 90% drawn.
      // This ensures the node appears at the moment the edge visually "arrives".
      const NODE_LAG = 0.90
      for (const [nodeId, el] of nodeEls) {
        const drivers = nodeDrivers.get(nodeId)
        let fraction: number
        if (drivers && drivers.length > 0) {
          const edgeFraction = Math.max(...drivers.map(r => fractionOf.get(r) ?? 0))
          fraction = smoothstep((edgeFraction - NODE_LAG) / (1 - NODE_LAG))
        } else {
          fraction = smoothstep((waveRadius - (nodeDist.get(nodeId) ?? 0)) / ROLLOFF)
        }
        el.style.opacity = String(FOG_OPACITY + (1 - FOG_OPACITY) * fraction)
      }

      if (now - start < totalDuration) {
        this.requestTransientFrame(tick)
      } else {
        for (const el of nodeEls.values()) el.style.opacity = '1'
        for (const { el } of edgeReveals) { el.style.strokeDasharray = ''; el.style.strokeDashoffset = '' }
      }
    }
    this.requestTransientFrame(tick)
  }

  /** Reverse of revealNodesRadial: fade nodes back into fog as a wave contracts inward. */
  private collapseNodesRadial(_center: {x: number, y: number}, becomingFog: Set<string>): void {
    if (becomingFog.size === 0) return

    const FADE_DURATION = 380  // ms — slightly slower than reveal for a gentle settling feel
    const FOG_OPACITY = 0.09
    const smoothstep = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c) }

    // Nodes: collect elements and starting opacities
    const nodeEls = new Map<string, { el: SVGGElement; fromOpacity: number }>()
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (d) {
      if (becomingFog.has(d.data.id)) {
        const fromOpacity = parseFloat(this.style.opacity || '1')
        // Apply fog filter immediately (they're fading out so blurriness adds to the effect)
        this.style.filter = 'url(#fog-blur)'
        nodeEls.set(d.data.id, { el: this, fromOpacity })
      }
    })

    // Edges: fade back to fog opacity
    const edgeEls: { el: SVGPathElement; fromOpacity: number }[] = []
    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (d) {
      if (becomingFog.has(d.link.source.data.id) || becomingFog.has(d.link.target.data.id)) {
        const fromOpacity = parseFloat(this.style.opacity || '1')
        // Clear any dasharray from reveal animation
        this.style.strokeDasharray = ''
        this.style.strokeDashoffset = ''
        edgeEls.push({ el: this, fromOpacity })
      }
    })

    const start = performance.now()
    const tick = (now: number) => {
      const t = smoothstep(Math.min((now - start) / FADE_DURATION, 1))

      for (const { el, fromOpacity } of nodeEls.values()) {
        el.style.opacity = String(fromOpacity + (FOG_OPACITY - fromOpacity) * t)
      }
      for (const { el, fromOpacity } of edgeEls) {
        el.style.opacity = String(fromOpacity + (0.04 - fromOpacity) * t)
      }

      if (now - start < FADE_DURATION) {
        this.requestTransientFrame(tick)
      } else {
        // Settle to exact fog state
        for (const { el } of nodeEls.values()) el.style.opacity = String(FOG_OPACITY)
        for (const { el } of edgeEls) el.style.opacity = '0.04'
      }
    }
    this.requestTransientFrame(tick)
  }

  // ── Flutter animation ──────────────────────────────────────────────

  private startFlutter(): void {
    if (this.flutterRAF !== null) return
    const tick = () => {
      this.flutterTick?.()
      this.flutterRAF = requestAnimationFrame(tick)
    }
    this.flutterRAF = requestAnimationFrame(tick)
  }

  private stopFlutter(): void {
    if (this.flutterRAF !== null) {
      cancelAnimationFrame(this.flutterRAF)
      this.flutterRAF = null
    }
    this.flutterTick = null
  }

  // ── Node selection ─────────────────────────────────────────────────

  /**
   * Reveal a node's 1-hop neighborhood (if in fog) then select it.
   * Use this when navigating programmatically (URL hash, search results).
   */
  private revealAndSelect(id: string, animate = false, center = false): void {
    if (!this.visibleNodes.has(id)) {
      this.expandedNodes.add(id)
      // Get simulation position for wave animation center
      let waveCenter: {x: number, y: number} | undefined
      if (animate) {
        d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(d => {
          if (d.data.id === id) waveCenter = { x: d.x ?? 0, y: d.y ?? 0 }
        })
      }
      this.updateTierVisibility(animate, waveCenter)
    }
    this.selectNode(id)
    if (center) setTimeout(() => this.centerOnNode(id), 300)
  }

  private centerOnNode(id: string): void {
    if (!this.svgEl || !this.zoomBehavior) return
    let nodePos: { x: number, y: number } | null = null
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(d => {
      if (d.data.id === id) nodePos = { x: d.x ?? 0, y: d.y ?? 0 }
    })
    if (!nodePos) return
    // Compute visible center: full viewport minus sidebar width when open
    const svgRect = (this.svgEl.node() as SVGElement).getBoundingClientRect()
    const sidebar = this.panel.querySelector('.tapestry-sidebar') as HTMLElement | null
    const sidebarW = (sidebar?.classList.contains('expanded') ? sidebar.getBoundingClientRect().width : 0)
    const visibleCenterX = (svgRect.width - sidebarW) / 2
    const visibleCenterY = svgRect.height / 2
    this.svgEl.transition().duration(700).ease(easeCubicInOut)
      .call(
        this.zoomBehavior.translateTo,
        (nodePos as {x: number, y: number}).x,
        (nodePos as {x: number, y: number}).y,
        [visibleCenterX, visibleCenterY],
      )
  }

  private selectNode(id: string): void {
    this.selectedNodeId = id
    this.updateHighlighting()
    this.detailPanelController.renderNode(id)
    this.preloadNeighborArtifacts(id)
    if (!this.staticMode) void this.annotations.load(id)
    this.pushHash(id)
  }

  /** BFS upstream from selectedId to find the nearest tier:1 ancestor.
   *  Returns the set of node IDs and edge keys ("sourceId->targetId") on that path. */
  private updateHighlighting(): void {
    if (!this.selectedNodeId || !this.tapestryData) return

    const selectedId = this.selectedNodeId
    const connectedNodes = new Set([selectedId])
    this.tapestryData.nodes.forEach(n => {
      if (n.id === selectedId) {
        n.dependsOn.forEach(dep => connectedNodes.add(dep))
      }
      if (n.dependsOn.includes(selectedId)) {
        connectedNodes.add(n.id)
      }
    })

    const visibleNodes = this.visibleNodes
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (d) {
      const el = d3Selection.select(this)
      // Don't override opacity for fog (non-visible) nodes
      if (!visibleNodes.has(d.data.id)) return
      const isSelected = d.data.id === selectedId
      const isConnected = connectedNodes.has(d.data.id)

      const opacity = isSelected ? 1.0 : isConnected ? 0.7 : 0.3

      el.classed('selected', isSelected)
        .style('opacity', String(opacity))
    })

    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (d) {
      const linkEl = d3Selection.select(this)
      const sourceId = d.link.source.data.id
      const targetId = d.link.target.data.id
      const touchesSelected = sourceId === selectedId || targetId === selectedId
      const baseColor = stalenessColor(d.link.target.data.staleness)

      linkEl
        .attr('stroke-opacity', touchesSelected ? 0.75 : 0.3)
        .attr('stroke', baseColor)
        .attr('stroke-width', 1)
    })
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

  /** Preload the first image artifact for upstream/downstream neighbors. */
  private preloadNeighborArtifacts(nodeId: string): void {
    if (!this.tapestryData) return
    const node = this.tapestryData.nodes.find(n => n.id === nodeId)
    if (!node) return

    const neighborIds = new Set<string>()
    node.dependsOn.forEach(id => neighborIds.add(id))
    const downstream = this.tapestryData.downstream[nodeId] || []
    downstream.forEach(d => neighborIds.add(d.id))

    for (const nId of neighborIds) {
      const neighbor = this.tapestryData.nodes.find(n => n.id === nId)
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

  // ── Refresh ──────────────────────────────────────────────────────────

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
      this.renderDAG()
      this.renderFiberList()

      // Re-select the node if it still exists
      if (selectedId) {
        const node = this.tapestryData?.nodes.find(n => n.id === selectedId)
        if (node) {
          this.selectNode(selectedId)
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

  // ── Inline markdown editing ──────────────────────────────────────────

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

  private hideDetail(skipVisibilityUpdate = false): void {
    this.cleanupDetailBindings()
    this.lightbox.close()
    this.detailBody.destroy()
    this.detailPanelController.hide()
    this.selectedNodeId = null
    this.pushHash(null)
    if (!this.staticMode) this.annotations.hidePanel()
    this.panel.querySelector('.tapestry-ann-popover')?.remove()

    // Restore visibility to skeleton + expanded sections (clears selected neighborhood)
    // Skip when caller already ran updateTierVisibility (e.g. collapse-all animation in progress)
    if (!skipVisibilityUpdate) this.updateTierVisibility()

    // Reset node highlighting (skip fog nodes — their opacity is managed by updateTierVisibility)
    const visibleNodes = this.visibleNodes
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node')
      .classed('selected', false)
      .each(function (d) {
        if (visibleNodes.has(d.data.id)) {
          d3Selection.select(this).style('opacity', '1')
        }
      })
    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (d) {
      d3Selection.select(this)
        .attr('stroke-opacity', 0.3)
        .attr('stroke', stalenessColor(d.link.target.data.staleness))
        .attr('stroke-width', 1)
    })
  }

  /** Navigate to a fiber: select in DAG if it's a rule fiber, otherwise show in sidebar detail. */
  private navigateToFiber(fiberId: string): void {
    if (!this.tapestryData) return
    const dagNode = this.tapestryData.nodes.find(n => n.id === fiberId)
    if (dagNode) {
      this.selectNode(fiberId)
      setTimeout(() => this.centerOnNode(fiberId), 50)
    } else if (this.tapestryData.fibers?.find(f => f.id === fiberId)) {
      this.selectFiber(fiberId)
    } else {
      this.openFileFromLink(`.felt/${fiberId}.md`)
    }
  }

  /** Open a file path in the file viewer, resolving relative to city root. */
  private openFileFromLink(href: string, line?: number): void {
    if (this.staticMode) {
      this.staticFileModal?.open(href, line)
      return
    }
    if (!this.onOpenFile || !this.currentCity) return
    const path = href.startsWith('/') ? href : `${this.currentCity.path}/${href}`
    this.onOpenFile(path, this.currentCity, line)
  }

  /**
   * Find inline <code> elements whose text matches a config key and
   * append the resolved value as a styled annotation.
   */
  private interpolateConfig(container: HTMLElement): void {
    const config = this.tapestryData?.config
    if (!config) return
    interpolateConfig(container, config)
  }

  // ── Fiber sidebar ──────────────────────────────────────────────────

  private renderFiberList(): void {
    if (!this.tapestryData) return
    const fibers = this.tapestryData.fibers || []
    const query = this.fiberSearchInput.value.toLowerCase().trim()

    const filtered = query
      ? fibers.filter(f => {
          const text = [f.title, f.body, f.kind, f.id, f.outcome,
            ...(f.tags || [])].filter(Boolean).join(' ').toLowerCase()
          return text.includes(query)
        })
      : fibers

    const isRule = (f: TapestryFiber) => f.tags?.some(t => t.startsWith('tapestry:')) ?? false

    // Staleness order: stale first (needs attention), then no-evidence, then fresh
    const stalenessOrder: Record<string, number> = { stale: 0, 'no-evidence': 1, fresh: 2 }
    const statusOrder: Record<string, number> = { active: 0, open: 1, untracked: 2, closed: 3 }

    const sorted = [...filtered].sort((a, b) => {
      const aRule = isRule(a) ? 0 : 1
      const bRule = isRule(b) ? 0 : 1
      if (aRule !== bRule) return aRule - bRule
      // Within rule fibers, sort by staleness (stale first)
      if (aRule === 0 && bRule === 0) {
        const aDag = this.tapestryData!.nodes.find(n => n.id === a.id)
        const bDag = this.tapestryData!.nodes.find(n => n.id === b.id)
        const aStal = stalenessOrder[aDag?.staleness || 'no-evidence'] ?? 1
        const bStal = stalenessOrder[bDag?.staleness || 'no-evidence'] ?? 1
        if (aStal !== bStal) return aStal - bStal
      }
      const aStatus = statusOrder[a.status] ?? 2
      const bStatus = statusOrder[b.status] ?? 2
      if (aStatus !== bStatus) return aStatus - bStatus
      return a.title.localeCompare(b.title)
    })

    this.fiberResultsEl.innerHTML = sorted.map(f => {
      const dagNode = this.tapestryData!.nodes.find(n => n.id === f.id)
      const ruleTag = isRule(f)

      // Unified dot: status shape + staleness color (for DAG nodes) or neutral
      const dotColor = dagNode ? stalenessColor(dagNode.staleness) : '#7A7368'
      const dotIcon = statusIcon(f.status)

      // Non-tapestry tags
      const nonRuleTags = (f.tags || []).filter(t => !t.startsWith('tapestry:'))
      const tagsHtml = nonRuleTags.map(t =>
        `<span class="fiber-tag">${escapeHtml(t.replace(/^\[|\]$/g, ''))}</span>`
      ).join('')

      const kindBadge = f.kind !== 'task' ? `<span class="fiber-kind">${escapeHtml(f.kind)}</span>` : ''
      const ruleClass = ruleTag ? ' fiber-item-rule' : ''
      return `<div class="fiber-item${ruleClass}" data-fiber-id="${escapeHtml(f.id)}">
        <span class="fiber-dot" style="color: ${dotColor}">${dotIcon}</span>
        <span class="fiber-title">${escapeHtml(shortName(f.title))}</span>
        ${tagsHtml}${kindBadge}
      </div>`
    }).join('')

    // Bind click handlers
    this.fiberResultsEl.querySelectorAll('.fiber-item').forEach(el => {
      el.addEventListener('click', () => {
        const fiberId = (el as HTMLElement).dataset.fiberId
        if (!fiberId) return
        const dagNode = this.tapestryData?.nodes.find(n => n.id === fiberId)
        if (dagNode) {
          this.selectNode(fiberId)
        } else {
          this.selectFiber(fiberId)
        }
      })
    })
  }

  /** Show detail panel for a non-DAG fiber. */
  private selectFiber(fiberId: string): void {
    this.selectedNodeId = fiberId
    this.pushHash(fiberId)
    this.detailBody.destroy()
    this.detailPanelController.renderFiber(fiberId)
  }

  // ── Search ─────────────────────────────────────────────────────────

  private handleSearch(): void {
    const query = this.fiberSearchInput.value.toLowerCase().trim()
    this.clearSearchHighlights()
    this.searchResults.innerHTML = ''
    this.searchFocusIdx = -1

    if (!query || !this.tapestryData) return

    const matches: Array<{ node: TapestryNode; context: string }> = []
    this.tapestryData.nodes.forEach(node => {
      const searchText = [node.title, node.body, node.kind, node.id]
        .filter(Boolean).join(' ').toLowerCase()
      if (searchText.includes(query)) {
        const idx = searchText.indexOf(query)
        const start = Math.max(0, idx - SEARCH_SNIPPET_CONTEXT)
        const end = Math.min(searchText.length, idx + query.length + SEARCH_SNIPPET_CONTEXT)
        let snippet = searchText.substring(start, end)
        if (start > 0) snippet = '...' + snippet
        if (end < searchText.length) snippet = snippet + '...'
        matches.push({ node, context: snippet })
      }
    })

    // Highlight matching nodes
    matches.forEach(m => {
      d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node')
        .filter(d => d.data.id === m.node.id)
        .classed('search-match', true)
    })

    if (matches.length === 0) {
      this.searchResults.innerHTML = '<div class="search-no-results">no matches</div>'
    } else {
      matches.forEach(m => {
        const color = stalenessColor(m.node.staleness)
        const div = document.createElement('div')
        div.className = 'search-result'
        div.innerHTML = `
          <span class="search-result-dot" style="background: ${color}"></span>
          <span class="search-result-name">${escapeHtml(shortName(m.node.title))}</span>
          <span class="search-result-match">${escapeHtml(m.context)}</span>
        `
        div.addEventListener('click', () => {
          this.revealAndSelect(m.node.id, true, true)
          this.fiberSearchInput.value = ''
          this.searchResults.innerHTML = ''
          this.clearSearchHighlights()
          this.searchFocusIdx = -1
          this.renderFiberList()
        })
        this.searchResults.appendChild(div)
      })
    }
  }

  private clearSearchHighlights(): void {
    d3Selection.selectAll('.tapestry-node').classed('search-match', false)
  }

  private updateSearchFocus(): void {
    const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
    results.forEach((r, i) => r.classList.toggle('search-focused', i === this.searchFocusIdx))
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
