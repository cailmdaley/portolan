// RhizomeView — native DAG visualization for fibers.
// D3 force-directed layout with organic node shapes, staleness coloring,
// fiber detail panel, and annotation support.

import * as d3Force from 'd3-force'
import * as d3Selection from 'd3-selection'
import * as d3Drag from 'd3-drag'
import * as d3Zoom from 'd3-zoom'
import type { City } from '../state/types'
import { escapeHtml, renderMarkdown, highlightCodeBlocks, showToast } from './utils'
import { type WorkerInfo } from './WorkerPicker'
import { AnnotationPanel, type BaseAnnotation } from './AnnotationPanel'

const API_BASE = `http://${window.location.hostname}:4004`

// ── Types ────────────────────────────────────────────────────────────

interface RhizomeNode {
  id: string
  title: string
  kind: string
  status: string
  body: string
  dependsOn: string[]
  specName: string | null
  staleness: 'fresh' | 'stale' | 'no-evidence'
  evidence: {
    metrics: Record<string, unknown>
    artifacts: Record<string, string>
    mtime: number
    generated: string | null
  } | null
}

interface RhizomeLink {
  source: string
  target: string
}

interface RhizomeResponse {
  nodes: RhizomeNode[]
  links: RhizomeLink[]
  downstream: Record<string, Array<{ id: string; title: string; status: string; kind: string }>>
}

/** D3 simulation node with position. */
interface SimNode extends d3Force.SimulationNodeDatum {
  id: string
  data: RhizomeNode
  degree: number
}

/** D3 simulation link with resolved node references. */
interface SimLink extends d3Force.SimulationLinkDatum<SimNode> {
  source: SimNode
  target: SimNode
}

interface ClaimsAnnotation extends BaseAnnotation {
  claimId: string
  claimTitle?: string
  selectedText?: string
  artifact?: string
  x?: number
  y?: number
  isImageAnnotation?: boolean
}

// ── Constants ────────────────────────────────────────────────────────

const NODE_RX = 52
const NODE_RY = 18
const RING_SCALES = [1.0, 1.15]
const RING_COUNT = RING_SCALES.length

const STALENESS_COLORS: Record<string, string> = {
  'fresh': '#5A7B7B',       // teal
  'stale': '#A87070',       // red
  'no-evidence': '#7A7368', // muted gray
}

function stalenessColor(staleness: string): string {
  return STALENESS_COLORS[staleness] || STALENESS_COLORS['no-evidence']
}

// ── Procedural helpers ───────────────────────────────────────────────

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function noise2D(x: number, y: number, seed: number): number {
  const s = seed * 1000
  return (
    Math.sin(x * 1.7 + y * 2.3 + s) * 0.4 +
    Math.sin(x * 3.1 - y * 1.1 + s * 1.3) * 0.35 +
    Math.sin(x * 0.9 + y * 4.1 + s * 0.7) * 0.25
  )
}

function organicEllipse(rx: number, ry: number, seed: number, scale = 1): string {
  const points = 64
  const resolution = 0.08
  const amplitude = 0.07

  const coords: Array<{ x: number; y: number }> = []
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * Math.PI * 2
    const baseX = rx * scale * Math.cos(theta)
    const baseY = ry * scale * Math.sin(theta)
    const n = noise2D(baseX * resolution, baseY * resolution, seed)
    coords.push({
      x: baseX * (1 + n * amplitude),
      y: baseY * (1 + n * amplitude),
    })
  }

  let d = `M${coords[0].x},${coords[0].y}`
  for (let i = 1; i < points; i++) {
    d += ` L${coords[i].x},${coords[i].y}`
  }
  d += ' Z'
  return d
}

function ringOpacity(index: number): number {
  return 0.9 * (1 - index / (RING_SCALES.length * 3))
}

function ellipsePoint(cx: number, cy: number, rx: number, ry: number, theta: number): { x: number; y: number } {
  return {
    x: cx + rx * Math.cos(theta),
    y: cy + ry * Math.sin(theta),
  }
}

function shortName(title: string): string {
  const clean = title.replace(/-[a-f0-9]{8}$/, '')
  const words = clean.replace(/[-_]/g, ' ').split(' ').filter(w => w)
  return words.slice(0, 3).join(' ')
}

function stalenessIcon(staleness: RhizomeNode['staleness']): string {
  if (staleness === 'fresh') return '\u25CF'
  if (staleness === 'stale') return '\u25CC'
  return '\u25CB'
}

// ── RhizomeView ──────────────────────────────────────────────────────

export class RhizomeView {
  private panel: HTMLElement
  private closeBtn: HTMLElement
  private dagContainer: HTMLElement
  private detailPanel: HTMLElement
  private searchInput: HTMLInputElement
  private searchResults: HTMLElement
  private loadingIndicator: HTMLElement
  private annotationPanelEl: HTMLElement
  private annotationPanel: AnnotationPanel<ClaimsAnnotation>

  private currentCity: City | null = null
  private rhizomeData: RhizomeResponse | null = null
  private selectedNodeId: string | null = null
  private simulation: d3Force.Simulation<SimNode, SimLink> | null = null
  private currentPlotIndex = 0

  // HMR-safe listener refs
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private onGetWorkers: ((city: City) => WorkerInfo[]) | null = null

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.rhizome-close')!
    this.dagContainer = this.panel.querySelector('.rhizome-dag')!
    this.detailPanel = this.panel.querySelector('.rhizome-detail')!
    this.searchInput = this.panel.querySelector('.rhizome-search input') as HTMLInputElement
    this.searchResults = this.panel.querySelector('.rhizome-search-results')!
    this.loadingIndicator = this.panel.querySelector('.rhizome-loading')!
    this.annotationPanelEl = this.panel.querySelector('.rhizome-annotation-panel')!

    this.annotationPanel = new AnnotationPanel<ClaimsAnnotation>(this.annotationPanelEl, {
      cssPrefix: 'claims',
      emptyMessage: 'Select text or click an image to annotate',

      renderPreview: (ann) => {
        if (ann.selectedText) {
          const truncated = ann.selectedText.slice(0, 80)
          const ellipsis = ann.selectedText.length > 80 ? '\u2026' : ''
          return `<div class="ann-selected-text">\u201c${escapeHtml(truncated)}${ellipsis}\u201d</div>`
        }
        if (ann.artifact) {
          return `<div class="ann-pin-label">\u{1F4CC} ${escapeHtml(ann.artifact)} (${Math.round(ann.x || 0)}%, ${Math.round(ann.y || 0)}%)</div>`
        }
        return ''
      },

      onPromote: (ann) => this.handleAnnotationPromote(ann),

      onRefresh: () => {
        if (this.selectedNodeId) {
          return this.loadAnnotations(this.selectedNodeId)
        }
      },

      buildLoadQuery: () => {
        if (!this.selectedNodeId) return ''
        return `claimId=${encodeURIComponent(this.selectedNodeId)}`
      },

      getWorkers: () => {
        if (!this.currentCity || !this.onGetWorkers) return []
        return this.onGetWorkers(this.currentCity)
      },

      onSendToWorker: (annotations, workerId, createNew) =>
        this.sendAnnotationsToWorker(annotations, workerId, createNew),

      globalCommentPlaceholder: 'General feedback\u2026',
    })

    this.setupEventListeners()
    document.body.appendChild(this.panel)
  }

  // ── DOM construction ───────────────────────────────────────────────

  private createPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.className = 'rhizome-view'
    panel.innerHTML = `
      <button class="rhizome-close">&times;</button>
      <div class="rhizome-body">
        <div class="rhizome-main">
          <div class="rhizome-dag-wrapper">
            <div class="rhizome-loading">Loading rhizome\u2026</div>
            <div class="rhizome-dag"></div>
            <div class="rhizome-search">
              <input type="text" placeholder="Search fibers\u2026" />
              <div class="rhizome-search-results"></div>
            </div>
          </div>
          <div class="rhizome-detail hidden"></div>
        </div>
        <div class="rhizome-annotation-panel hidden">
          ${AnnotationPanel.buildPanelHTML({
            globalCommentPlaceholder: 'General feedback\u2026',
            showSaveButton: true,
          })}
        </div>
      </div>
    `
    return panel
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.hide())

    // Global feedback save
    const globalSaveBtn = this.annotationPanelEl.querySelector('.ann-global-save')
    const globalTextarea = this.annotationPanelEl.querySelector('.ann-panel-global-input textarea') as HTMLTextAreaElement | null

    if (globalSaveBtn && globalTextarea) {
      globalSaveBtn.addEventListener('click', () => {
        this.saveGlobalFeedback(globalTextarea)
      })
      globalTextarea.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          this.saveGlobalFeedback(globalTextarea)
        }
      })
    }

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isVisible()) {
        if (this.detailPanel.classList.contains('hidden')) {
          this.hide()
        } else {
          this.hideDetail()
        }
      }
    }

    // Search
    this.searchInput.addEventListener('input', () => this.handleSearch())
    this.searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.searchInput.value = ''
        this.searchResults.innerHTML = ''
        this.clearSearchHighlights()
        this.searchInput.blur()
      }
    })

    // Text selection for annotation
    this.detailPanel.addEventListener('mouseup', () => {
      const selection = window.getSelection()
      if (selection && selection.toString().trim().length > 0) {
        this.handleTextSelection(selection)
      }
    })
  }

  // ── Public API ─────────────────────────────────────────────────────

  async show(city: City): Promise<void> {
    this.currentCity = city
    this.selectedNodeId = null
    this.currentPlotIndex = 0

    this.annotationPanel.hidePanel()
    this.annotationPanel.reset()
    this.hideDetail()

    this.loadingIndicator.style.display = 'flex'
    this.loadingIndicator.textContent = 'Loading rhizome\u2026'
    this.loadingIndicator.classList.remove('error')
    this.dagContainer.innerHTML = ''

    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
    this.panel.classList.add('visible')

    try {
      const response = await fetch(`${API_BASE}/rhizome?cityId=${encodeURIComponent(city.id)}`)
      if (!response.ok) throw new Error(await response.text())
      this.rhizomeData = await response.json()
      this.loadingIndicator.style.display = 'none'
      this.renderDAG()
    } catch (err) {
      this.loadingIndicator.textContent = 'Failed to load rhizome'
      this.loadingIndicator.classList.add('error')
      console.error('Rhizome fetch failed:', err)
    }
  }

  hide(): void {
    this.panel.classList.remove('visible')
    this.panel.querySelector('.rhizome-ann-popover')?.remove()
    this.currentCity = null
    this.selectedNodeId = null
    this.rhizomeData = null
    this.annotationPanel.reset()

    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
    }

    if (this.simulation) {
      this.simulation.stop()
      this.simulation = null
    }

    setTimeout(() => {
      if (!this.isVisible()) {
        this.dagContainer.innerHTML = ''
        this.detailPanel.innerHTML = ''
        this.detailPanel.classList.add('hidden')
      }
    }, 300)
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }

  dispose(): void {
    this.hide()
    this.panel.remove()
  }

  setOnGetWorkers(fn: (city: City) => WorkerInfo[]): void {
    this.onGetWorkers = fn
  }

  // ── DAG rendering ──────────────────────────────────────────────────

  private renderDAG(): void {
    if (!this.rhizomeData) return

    const { nodes: rawNodes, links: rawLinks } = this.rhizomeData
    if (rawNodes.length === 0) {
      this.dagContainer.innerHTML = '<div class="rhizome-empty">No rule: fibers found</div>'
      return
    }

    const containerRect = this.dagContainer.getBoundingClientRect()
    const width = Math.max(containerRect.width || 800, 800)
    const height = Math.max(containerRect.height || 600, 600)

    // Build simulation nodes with tier-based initial positions
    const tierCounts: Record<number, number> = {}
    const tierIndices: Record<number, number> = {}

    // Compute tiers from dependency depth
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
    const maxTier = Math.max(...Array.from(depthMap.values()), 0)

    rawNodes.forEach(n => {
      const tier = depthMap.get(n.id) || 0
      tierCounts[tier] = (tierCounts[tier] || 0) + 1
    })

    const simNodes: SimNode[] = rawNodes.map(n => {
      const tier = depthMap.get(n.id) || 0
      tierIndices[tier] = tierIndices[tier] || 0
      const indexInTier = tierIndices[tier]++
      const countInTier = tierCounts[tier]

      const tierSpacing = width / (maxTier + 2)
      const verticalSpacing = height / (countInTier + 1)

      return {
        id: n.id,
        data: n,
        degree: 0,
        x: tierSpacing * (tier + 1),
        y: verticalSpacing * (indexInTier + 1),
      }
    })

    const simNodeMap = new Map(simNodes.map(n => [n.id, n]))

    const simLinks: SimLink[] = rawLinks
      .map(l => ({
        source: simNodeMap.get(l.source)!,
        target: simNodeMap.get(l.target)!,
      }))
      .filter(l => l.source && l.target)

    // Compute degrees
    simLinks.forEach(link => {
      link.source.degree++
      link.target.degree++
    })

    // Force simulation
    this.simulation = d3Force.forceSimulation<SimNode>(simNodes)
      .force('link', d3Force.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(100)
        .strength(link => {
          const tgt = (link.target as SimNode).degree || 1
          const src = (link.source as SimNode).degree || 1
          return 1 / Math.max(tgt, src)
        }))
      .force('charge', d3Force.forceManyBody().strength(-400))
      .force('collide', d3Force.forceCollide<SimNode>().radius(60).strength(0.9))
      .force('x', d3Force.forceX(width / 2).strength(0.03))
      .force('y', d3Force.forceY(height / 2).strength(0.05))
      .alphaDecay(0.02)
      .velocityDecay(0.85)
      .stop()

    // Pre-run simulation
    const visualGap = 60
    const minSeparation = 2 * NODE_RX + visualGap

    for (let i = 0; i < 500; i++) {
      this.simulation.tick()
      for (let iter = 0; iter < 3; iter++) {
        simLinks.forEach(link => {
          const minX = link.source.x! + minSeparation
          if (link.target.x! < minX) {
            const diff = minX - link.target.x!
            link.target.x! += diff * 0.5
            link.source.x! -= diff * 0.5
          }
        })
      }
    }

    // Create SVG
    const svg = d3Selection.select(this.dagContainer)
      .append('svg')
      .attr('class', 'rhizome-svg')

    // Zoom behavior
    const zoomBehavior = d3Zoom.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        rootGroup.attr('transform', event.transform)
      })

    svg.call(zoomBehavior)

    const rootGroup = svg.append('g')

    // Draw edges
    const edgeGroup = rootGroup.append('g').attr('class', 'rhizome-edges')
    const edgePaths: d3Selection.Selection<SVGPathElement, unknown, null, undefined>[] = []

    simLinks.forEach(link => {
      const color = stalenessColor(link.target.data.staleness)
      const edgeRand = seededRandom(hashString(link.source.data.id + link.target.data.id))
      const tension = 0.4 + edgeRand() * 0.1
      const cpOffset1 = (edgeRand() - 0.5) * 8
      const cpOffset2 = (edgeRand() - 0.5) * 8

      for (let s = 0; s < RING_COUNT; s++) {
        const strandOpacity = ringOpacity(s) * 0.4

        const path = edgeGroup.append('path')
          .datum({ link, strandIndex: s, tension, cpOffset1, cpOffset2 })
          .attr('class', 'rhizome-link')
          .attr('stroke', color)
          .attr('stroke-width', 1)
          .attr('stroke-opacity', strandOpacity)
          .attr('stroke-linecap', 'round') as d3Selection.Selection<SVGPathElement, unknown, null, undefined>

        edgePaths.push(path)
      }
    })

    // Draw nodes
    const nodeGroup = rootGroup.append('g').attr('class', 'rhizome-nodes')
    let draggedDistance = 0

    const nodeElements = nodeGroup.selectAll<SVGGElement, SimNode>('.rhizome-node')
      .data(simNodes)
      .enter()
      .append('g')
      .attr('class', 'rhizome-node')
      .call(d3Drag.drag<SVGGElement, SimNode>()
        .on('start', (event, d) => {
          draggedDistance = 0
          if (!event.active) this.simulation?.alphaTarget(0.3).restart()
          d.fy = d.y
          d3Selection.select(event.sourceEvent.target.closest('.rhizome-node') as Element)
            .style('cursor', 'ns-resize')
        })
        .on('drag', (event, d) => {
          draggedDistance += Math.abs(event.dx) + Math.abs(event.dy)
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) this.simulation?.alphaTarget(0)
          d.fy = null
          d3Selection.select(event.sourceEvent.target.closest('.rhizome-node') as Element)
            .style('cursor', 'grab')
          if (draggedDistance < 5) {
            this.selectNode(d.data.id)
          }
        }))

    // Build node visuals
    nodeElements.each(function (d) {
      const g = d3Selection.select(this)
      const color = stalenessColor(d.data.staleness)
      const nodeSeed = hashString(d.data.id) / 1000000

      // Fill layers
      for (let i = RING_COUNT - 1; i >= 0; i--) {
        const scale = RING_SCALES[i]
        const fillOpacity = 0.12 + (RING_COUNT - 1 - i) * 0.06
        g.append('path')
          .attr('class', 'rhizome-node-fill')
          .attr('d', organicEllipse(NODE_RX, NODE_RY, nodeSeed + i * 0.1, scale))
          .attr('fill', color)
          .attr('fill-opacity', fillOpacity)
          .attr('stroke', 'none')
      }

      // Ring strokes
      for (let i = 0; i < RING_COUNT; i++) {
        const scale = RING_SCALES[i]
        const isCore = i === 0
        g.append('path')
          .attr('class', 'rhizome-node-ring')
          .attr('d', organicEllipse(NODE_RX, NODE_RY, nodeSeed + i * 0.1, scale))
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', isCore ? 0.8 : 0.5)
          .attr('stroke-opacity', ringOpacity(i) * (isCore ? 0.85 : 1))
      }

      // Label
      const name = shortName(d.data.title)
      const words = name.split(' ')

      if (words.length > 2) {
        const mid = Math.ceil(words.length / 2)
        g.append('text')
          .attr('class', 'rhizome-node-label')
          .attr('y', -4)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9.5px')
          .text(words.slice(0, mid).join(' '))
        g.append('text')
          .attr('class', 'rhizome-node-label')
          .attr('y', 8)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9.5px')
          .text(words.slice(mid).join(' '))
      } else {
        g.append('text')
          .attr('class', 'rhizome-node-label')
          .attr('y', 3)
          .attr('text-anchor', 'middle')
          .attr('font-size', '10px')
          .text(name)
      }
    })

    // Update edge path positions
    const updateEdgePath = (pathEl: d3Selection.Selection<SVGPathElement, unknown, null, undefined>) => {
      const d = pathEl.datum() as {
        link: SimLink
        strandIndex: number
        tension: number
        cpOffset1: number
        cpOffset2: number
      }
      const link = d.link
      const s = d.strandIndex
      const ringScale = RING_SCALES[s]

      const spreadRange = Math.PI * 0.15
      const angleOffset = (s - 0.5) * spreadRange

      const start = ellipsePoint(
        link.source.x!, link.source.y!,
        NODE_RX * ringScale, NODE_RY * ringScale,
        angleOffset,
      )
      const end = ellipsePoint(
        link.target.x!, link.target.y!,
        NODE_RX * ringScale, NODE_RY * ringScale,
        Math.PI + angleOffset,
      )

      const dx = end.x - start.x
      const dy = end.y - start.y

      const cp1 = { x: start.x + dx * d.tension, y: start.y + dy * 0.1 + d.cpOffset1 }
      const cp2 = { x: end.x - dx * d.tension, y: end.y - dy * 0.1 + d.cpOffset2 }

      pathEl.attr('d', `M${start.x},${start.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${end.x},${end.y}`)
    }

    // Tick handler
    const margin = { top: 60, right: 80, bottom: 60, left: 80 }

    this.simulation.on('tick', () => {
      // DAG constraint: target right of source
      for (let iter = 0; iter < 3; iter++) {
        simLinks.forEach(link => {
          const minX = link.source.x! + minSeparation
          if (link.target.x! < minX) {
            link.target.x = minX
          }
        })
      }

      // Constrain within bounds
      simNodes.forEach(n => {
        n.x = Math.max(margin.left + NODE_RX, n.x!)
        n.y = Math.max(margin.top + NODE_RY, n.y!)
      })

      // Update viewBox
      const pad = 40
      const minNodeX = Math.min(...simNodes.map(n => n.x!)) - NODE_RX - pad
      const minNodeY = Math.min(...simNodes.map(n => n.y!)) - NODE_RY - pad
      const maxNodeX = Math.max(...simNodes.map(n => n.x!)) + NODE_RX + pad
      const maxNodeY = Math.max(...simNodes.map(n => n.y!)) + NODE_RY + pad

      // Only set viewBox on first tick (then zoom handles it)
      if (!svg.attr('viewBox')) {
        svg.attr('viewBox', `${minNodeX} ${minNodeY} ${maxNodeX - minNodeX} ${maxNodeY - minNodeY}`)
      }

      nodeElements.attr('transform', d => `translate(${d.x}, ${d.y})`)
      edgePaths.forEach(path => updateEdgePath(path))
    })

    // Gentle simulation for fine-tuning
    this.simulation.alpha(0.03).restart()
  }

  // ── Node selection ─────────────────────────────────────────────────

  private selectNode(id: string): void {
    this.selectedNodeId = id
    this.currentPlotIndex = 0
    this.updateHighlighting()
    this.renderDetailPanel(id)
    this.loadAnnotations(id)
  }

  private updateHighlighting(): void {
    if (!this.selectedNodeId || !this.rhizomeData) return

    const selectedId = this.selectedNodeId
    const connectedNodes = new Set([selectedId])
    this.rhizomeData.nodes.forEach(n => {
      if (n.id === selectedId) {
        n.dependsOn.forEach(dep => connectedNodes.add(dep))
      }
      if (n.dependsOn.includes(selectedId)) {
        connectedNodes.add(n.id)
      }
    })

    d3Selection.selectAll<SVGGElement, SimNode>('.rhizome-node').each(function (d) {
      const el = d3Selection.select(this)
      const isSelected = d.data.id === selectedId
      const isConnected = connectedNodes.has(d.data.id)

      let opacity = 0.3
      if (isSelected) opacity = 1.0
      else if (isConnected) opacity = 0.7

      el.classed('selected', isSelected)
        .style('opacity', String(opacity))
    })

    d3Selection.selectAll<SVGPathElement, { link: SimLink }>('.rhizome-link').each(function (d) {
      const linkEl = d3Selection.select(this)
      const sourceId = d.link.source.data.id
      const targetId = d.link.target.data.id
      const touchesSelected = sourceId === selectedId || targetId === selectedId
      linkEl.attr('stroke-opacity', touchesSelected ? 0.75 : 0.3)
    })
  }

  // ── Detail panel ───────────────────────────────────────────────────

  private renderDetailPanel(nodeId: string): void {
    if (!this.rhizomeData) return
    const node = this.rhizomeData.nodes.find(n => n.id === nodeId)
    if (!node) return

    const downstream = this.rhizomeData.downstream[nodeId] || []
    const nodeColor = stalenessColor(node.staleness)

    // Dependencies
    const depsHtml = node.dependsOn.length > 0
      ? `<div class="rhizome-detail-deps">
           <span class="deps-label">Depends on:</span>
           ${node.dependsOn.map(dep => {
             const depNode = this.rhizomeData!.nodes.find(n => n.id === dep)
             const name = depNode ? shortName(depNode.title) : dep.slice(0, 12)
             return `<span class="dep-tag" data-dep-id="${escapeHtml(dep)}">${escapeHtml(name)}</span>`
           }).join('')}
         </div>`
      : ''

    // Artifact viewer
    let artifactsHtml = ''
    if (node.evidence?.artifacts) {
      const entries = Object.entries(node.evidence.artifacts)
      if (entries.length > 0) {
        const [name, path] = entries[this.currentPlotIndex] || entries[0]
        const imgSrc = `${API_BASE}/rhizome-asset/${encodeURIComponent(node.specName || '')}/${encodeURIComponent(path.split('/').pop() || '')}?cityId=${encodeURIComponent(this.currentCity?.id || '')}`
        const hasMultiple = entries.length > 1
        artifactsHtml = `
          <div class="rhizome-artifact-viewer">
            ${hasMultiple ? `<span class="artifact-nav" data-delta="-1">\u2190</span>` : ''}
            <div class="rhizome-artifact">
              <span class="artifact-label">${escapeHtml(name)}${hasMultiple ? ` (${this.currentPlotIndex + 1}/${entries.length})` : ''}</span>
              <img src="${imgSrc}" alt="${escapeHtml(name)}" data-artifact-name="${escapeHtml(name)}" />
            </div>
            ${hasMultiple ? `<span class="artifact-nav" data-delta="1">\u2192</span>` : ''}
          </div>`
      }
    }

    // Body (markdown)
    const bodyHtml = node.body
      ? `<div class="rhizome-detail-body">${renderMarkdown(node.body)}</div>`
      : ''

    // Evidence metrics — flatten nested objects into key.subkey pairs
    let evidenceHtml = ''
    if (node.evidence?.metrics && Object.keys(node.evidence.metrics).length > 0) {
      const items: Array<{ key: string; value: string }> = []
      for (const [key, value] of Object.entries(node.evidence.metrics)) {
        if (typeof value === 'object' && value !== null) {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            items.push({ key: `${key}.${k}`, value: typeof v === 'number' ? v.toFixed(4) : String(v) })
          }
        } else {
          items.push({ key, value: typeof value === 'number' ? value.toFixed(4) : String(value) })
        }
      }
      const itemsHtml = items.map(({ key, value }) =>
        `<div class="evidence-item"><span class="evidence-key">${escapeHtml(key)}</span><span class="evidence-value">${escapeHtml(value)}</span></div>`
      ).join('')
      evidenceHtml = `
        <div class="rhizome-evidence-section">
          <h3 class="rhizome-collapsible" data-target="evidence-container">
            <span class="toggle-icon">\u25B8</span> Evidence
          </h3>
          <div class="evidence-container collapsed">
            <div class="rhizome-evidence">${itemsHtml}</div>
          </div>
        </div>`
    }

    // Downstream concerns
    let downstreamHtml = ''
    if (downstream.length > 0) {
      downstreamHtml = `
        <div class="rhizome-downstream-section">
          <h3 class="rhizome-collapsible" data-target="downstream-container">
            <span class="toggle-icon">\u25B8</span> Downstream (${downstream.length})
          </h3>
          <div class="downstream-container collapsed">
            ${downstream.map(d => {
              const icon = d.status === 'closed' ? '\u25CF' : d.status === 'active' ? '\u25D0' : '\u25CB'
              return `<div class="downstream-item">
                <span class="downstream-status">${icon}</span>
                <span class="downstream-title">${escapeHtml(d.title)}</span>
                <span class="downstream-kind">${escapeHtml(d.kind)}</span>
              </div>`
            }).join('')}
          </div>
        </div>`
    }

    this.detailPanel.innerHTML = `
      <div class="rhizome-detail-header">
        <div class="rhizome-detail-title">
          <span class="staleness-badge" style="color: ${nodeColor}">${stalenessIcon(node.staleness)}</span>
          <span class="detail-name">${escapeHtml(shortName(node.title))}</span>
          <span class="detail-status">${escapeHtml(node.status)}</span>
        </div>
        <button class="rhizome-detail-close">&times;</button>
      </div>
      <div class="rhizome-detail-content">
        ${depsHtml}
        ${artifactsHtml}
        ${bodyHtml}
        ${evidenceHtml}
        ${downstreamHtml}
      </div>
    `

    this.detailPanel.classList.remove('hidden')

    // Highlight code blocks in body
    const bodyContainer = this.detailPanel.querySelector('.rhizome-detail-body')
    if (bodyContainer) highlightCodeBlocks(bodyContainer as HTMLElement)

    // Bind detail panel events
    this.bindDetailEvents(node)
  }

  private bindDetailEvents(node: RhizomeNode): void {
    // Close button
    this.detailPanel.querySelector('.rhizome-detail-close')?.addEventListener('click', () => {
      this.hideDetail()
    })

    // Collapsible sections
    this.detailPanel.querySelectorAll('.rhizome-collapsible').forEach(h3 => {
      h3.addEventListener('click', () => {
        const target = h3.getAttribute('data-target')
        if (!target) return
        const container = this.detailPanel.querySelector(`.${target}`)
        const icon = h3.querySelector('.toggle-icon')
        if (container && icon) {
          const isCollapsed = container.classList.toggle('collapsed')
          icon.textContent = isCollapsed ? '\u25B8' : '\u25BE'
        }
      })
    })

    // Artifact navigation
    this.detailPanel.querySelectorAll('.artifact-nav').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const delta = parseInt((btn as HTMLElement).dataset.delta || '0')
        if (node.evidence?.artifacts) {
          const count = Object.keys(node.evidence.artifacts).length
          this.currentPlotIndex = (this.currentPlotIndex + delta + count) % count
          this.renderDetailPanel(node.id)
        }
      })
    })

    // Artifact image click → lightbox
    this.detailPanel.querySelectorAll('.rhizome-artifact img').forEach(img => {
      img.addEventListener('click', () => {
        this.openLightbox(img as HTMLImageElement, node)
      })
    })

    // Dependency tag click → navigate
    this.detailPanel.querySelectorAll('.dep-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        const depId = (tag as HTMLElement).dataset.depId
        if (depId) this.selectNode(depId)
      })
    })
  }

  private hideDetail(): void {
    this.detailPanel.classList.add('hidden')
    this.selectedNodeId = null
    this.annotationPanel.hidePanel()
    this.panel.querySelector('.rhizome-ann-popover')?.remove()

    // Reset node highlighting
    d3Selection.selectAll('.rhizome-node')
      .classed('selected', false)
      .style('opacity', 1)
    d3Selection.selectAll('.rhizome-link')
      .attr('stroke-opacity', 0.3)
  }

  // ── Lightbox ───────────────────────────────────────────────────────

  private openLightbox(img: HTMLImageElement, node: RhizomeNode): void {
    const lightbox = document.createElement('div')
    lightbox.className = 'rhizome-lightbox'

    const bigImg = document.createElement('img')
    bigImg.src = img.src
    bigImg.alt = img.alt

    const closeBtn = document.createElement('button')
    closeBtn.className = 'rhizome-lightbox-close'
    closeBtn.textContent = '\u00D7'

    lightbox.appendChild(bigImg)
    lightbox.appendChild(closeBtn)

    const close = () => lightbox.remove()
    closeBtn.addEventListener('click', close)
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) close()
    })

    // Image annotation: click on image to place pin
    bigImg.addEventListener('click', (e) => {
      e.stopPropagation()
      const rect = bigImg.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 100
      const y = ((e.clientY - rect.top) / rect.height) * 100
      this.promptImageAnnotation(node, img.dataset.artifactName || '', x, y)
      close()
    })

    document.addEventListener('keydown', function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        close()
        document.removeEventListener('keydown', handler)
      }
    })

    document.body.appendChild(lightbox)
  }

  // ── Search ─────────────────────────────────────────────────────────

  private handleSearch(): void {
    const query = this.searchInput.value.toLowerCase().trim()
    this.clearSearchHighlights()
    this.searchResults.innerHTML = ''

    if (!query || !this.rhizomeData) return

    const matches: Array<{ node: RhizomeNode; context: string }> = []
    this.rhizomeData.nodes.forEach(node => {
      const searchText = [node.title, node.body, node.kind, node.id]
        .filter(Boolean).join(' ').toLowerCase()
      if (searchText.includes(query)) {
        const idx = searchText.indexOf(query)
        const start = Math.max(0, idx - 15)
        const end = Math.min(searchText.length, idx + query.length + 15)
        let snippet = searchText.substring(start, end)
        if (start > 0) snippet = '...' + snippet
        if (end < searchText.length) snippet = snippet + '...'
        matches.push({ node, context: snippet })
      }
    })

    // Highlight matching nodes
    matches.forEach(m => {
      d3Selection.selectAll<SVGGElement, SimNode>('.rhizome-node')
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
          this.selectNode(m.node.id)
          this.searchInput.value = ''
          this.searchResults.innerHTML = ''
          this.clearSearchHighlights()
        })
        this.searchResults.appendChild(div)
      })
    }
  }

  private clearSearchHighlights(): void {
    d3Selection.selectAll('.rhizome-node').classed('search-match', false)
  }

  // ── Annotations ────────────────────────────────────────────────────

  private handleTextSelection(selection: Selection): void {
    const text = selection.toString().trim()
    if (!text || !this.selectedNodeId) return

    // Position popover near the selection
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const nodeId = this.selectedNodeId

    this.showAnnotationPopover(
      rect.left + rect.width / 2,
      rect.bottom + 4,
      `\u201c${text.slice(0, 60)}${text.length > 60 ? '\u2026' : ''}\u201d`,
    ).then(comment => {
      if (comment) {
        this.saveAnnotation({ claimId: nodeId, selectedText: text, comment })
      }
    })
  }

  private promptImageAnnotation(
    node: RhizomeNode,
    artifactName: string,
    x: number,
    y: number,
  ): void {
    // Position popover at click location (approximate viewport coords)
    this.showAnnotationPopover(
      window.innerWidth / 2,
      window.innerHeight / 2,
      `Pin on ${artifactName} (${Math.round(x)}%, ${Math.round(y)}%)`,
    ).then(comment => {
      if (comment) {
        this.saveAnnotation({
          claimId: node.id,
          artifact: artifactName,
          x, y, comment,
          isImageAnnotation: true,
        })
      }
    })
  }

  private showAnnotationPopover(
    anchorX: number,
    anchorY: number,
    preview: string,
  ): Promise<string | null> {
    return new Promise(resolve => {
      // Remove any existing popover
      this.panel.querySelector('.rhizome-ann-popover')?.remove()

      const popover = document.createElement('div')
      popover.className = 'rhizome-ann-popover'

      // Position: ensure it stays within viewport
      const popW = 280
      const popH = 160
      let left = Math.max(8, Math.min(anchorX - popW / 2, window.innerWidth - popW - 8))
      let top = anchorY + 8
      if (top + popH > window.innerHeight - 8) {
        top = anchorY - popH - 8
      }

      popover.style.left = `${left}px`
      popover.style.top = `${top}px`

      popover.innerHTML = `
        <div class="ann-popover-preview">${escapeHtml(preview)}</div>
        <textarea class="ann-popover-input" placeholder="Add comment\u2026" rows="3"></textarea>
        <div class="ann-popover-actions">
          <button class="ann-popover-cancel">Cancel</button>
          <button class="ann-popover-save">Save</button>
        </div>
      `

      const textarea = popover.querySelector('textarea')!
      const saveBtn = popover.querySelector('.ann-popover-save')!
      const cancelBtn = popover.querySelector('.ann-popover-cancel')!

      const close = (result: string | null) => {
        popover.remove()
        resolve(result)
      }

      saveBtn.addEventListener('click', () => {
        const val = textarea.value.trim()
        close(val || null)
      })

      cancelBtn.addEventListener('click', () => close(null))

      textarea.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          const val = textarea.value.trim()
          close(val || null)
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          close(null)
        }
      })

      this.panel.appendChild(popover)
      textarea.focus()
    })
  }

  private async saveAnnotation(data: {
    claimId: string
    selectedText?: string
    artifact?: string
    x?: number
    y?: number
    comment: string
    isImageAnnotation?: boolean
  }): Promise<void> {
    const response = await this.fetchApi('/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originId: this.currentCity?.originId || 'local',
        comment: data.comment,
        isClaimAnnotation: true,
        claimId: data.claimId,
        selectedText: data.selectedText,
        artifact: data.artifact,
        x: data.x,
        y: data.y,
        isImageAnnotation: !!data.isImageAnnotation,
      }),
    })

    if (response) {
      showToast('Annotation saved', 'success', 2000)
      this.annotationPanel.expand()
      this.loadAnnotations(data.claimId)
    }
  }

  private async loadAnnotations(nodeId: string): Promise<void> {
    const response = await this.fetchApi(
      `/annotations?claimId=${encodeURIComponent(nodeId)}`
    )
    if (!response) return

    const result = await response.json()
    const annotations: ClaimsAnnotation[] = result.annotations || []

    if (annotations.length > 0) {
      this.annotationPanel.expand()
    } else {
      this.annotationPanel.hidePanel()
    }

    this.annotationPanel.setAnnotations(annotations)
  }

  private async saveGlobalFeedback(textarea: HTMLTextAreaElement): Promise<void> {
    const comment = textarea.value.trim()
    if (!comment) return
    if (!this.selectedNodeId) {
      showToast('Select a fiber first', 'error', 2000)
      return
    }

    const response = await this.fetchApi('/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originId: this.currentCity?.originId || 'local',
        comment,
        isClaimAnnotation: true,
        claimId: this.selectedNodeId,
      }),
    })

    if (response) {
      textarea.value = ''
      textarea.style.height = ''
      showToast('Feedback saved', 'success', 2000)
      this.annotationPanel.expand()
      this.loadAnnotations(this.selectedNodeId)
    }
  }

  private async handleAnnotationPromote(ann: ClaimsAnnotation): Promise<void> {
    if (!this.currentCity) return

    const response = await this.fetchApi('/promote-to-felt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimId: ann.claimId,
        comment: ann.comment,
        cityId: this.currentCity.id,
      }),
    })

    if (response) {
      showToast('Promoted to felt', 'success', 2000)
    }
  }

  private async sendAnnotationsToWorker(
    annotations: ClaimsAnnotation[],
    workerId?: string,
    createNew?: boolean,
  ): Promise<void> {
    if (!this.currentCity) return

    const response = await this.fetchApi('/send-annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId,
        createNewWorker: createNew,
        filePath: this.currentCity.path + '/claims',
        originId: this.currentCity.originId,
        annotations,
        cityName: this.currentCity.name,
        isClaimsSend: true,
      }),
    })

    if (response) {
      showToast('Annotations sent to worker', 'success')
    }
  }

  // ── Fetch helper ───────────────────────────────────────────────────

  private async fetchApi(path: string, init?: RequestInit): Promise<Response | null> {
    try {
      const response = await fetch(`${API_BASE}${path}`, init)
      if (!response.ok) {
        console.error(`API error ${path}:`, await response.text())
        showToast('Request failed', 'error')
        return null
      }
      return response
    } catch (err) {
      console.error(`API error ${path}:`, err)
      showToast('Request failed', 'error')
      return null
    }
  }
}
