import * as d3Drag from 'd3-drag'
import type * as d3Force from 'd3-force'
import * as d3Selection from 'd3-selection'
import * as d3Zoom from 'd3-zoom'
import 'd3-transition'
import { easeCubicInOut } from 'd3-ease'
import { buildTapestryDagLayout } from './TapestryDagLayout'
import { renderDagNodeVisuals, updateDagEdgePath } from './TapestryDagRendering'
import { TapestryDagVisibility } from './TapestryDagVisibility'
import { escapeHtml } from './utils'
import type { SimLink, SimNode, SVGPathSelection, TapestryResponse } from './tapestry-types'
import {
  hashString,
  leadParagraph,
  NODE_RX,
  NODE_RY,
  RING_COUNT,
  ringOpacity,
  seededRandom,
  stalenessColor,
} from './tapestry-helpers'

interface TapestryDagGraphOptions {
  container: HTMLElement
  getInitialRevealThreshold: () => number
  onSelectNode: (id: string) => void
  onClearSelection: () => void
}

export class TapestryDagGraph {
  private container: HTMLElement
  private onSelectNode: (id: string) => void
  private data: TapestryResponse | null = null
  private simulation: d3Force.Simulation<SimNode, SimLink> | null = null
  private svgEl: d3Selection.Selection<SVGSVGElement, unknown, null, undefined> | null = null
  private zoomBehavior: d3Zoom.ZoomBehavior<SVGSVGElement, unknown> | null = null
  private flutterRAF: number | null = null
  private flutterTick: (() => void) | null = null
  private transientFrameIds = new Set<number>()
  private tooltip: HTMLElement | null = null
  private visibility: TapestryDagVisibility

  constructor(options: TapestryDagGraphOptions) {
    this.container = options.container
    this.onSelectNode = options.onSelectNode
    this.visibility = new TapestryDagVisibility({
      getData: () => this.data,
      getInitialRevealThreshold: () => options.getInitialRevealThreshold(),
      onSelectNode: (id) => this.onSelectNode(id),
      onClearSelection: () => options.onClearSelection(),
      requestTransientFrame: (callback) => this.requestTransientFrame(callback),
      restartSimulation: () => this.simulation?.alpha(0.05).restart(),
    })
    this.tooltip = document.createElement('div')
    this.tooltip.className = 'tapestry-hover-tooltip'
    document.body.appendChild(this.tooltip)
  }

  render(data: TapestryResponse): void {
    this.data = data
    this.visibility.reset()
    this.renderGraph()
  }

  clear(): void {
    this.cancelTransientFrames()
    if (this.tooltip) this.tooltip.style.display = 'none'
    this.stopFlutter()
    if (this.simulation) {
      this.simulation.stop()
      this.simulation = null
    }
    this.svgEl = null
    this.zoomBehavior = null
    this.visibility.reset()
    this.container.innerHTML = ''
  }

  destroy(): void {
    this.clear()
    if (this.tooltip) {
      this.tooltip.remove()
      this.tooltip = null
    }
  }

  getRuntimeStats(): {
    expandedNodeCount: number
    visibleNodeCount: number
    hasSimulation: boolean
    hasSvg: boolean
    hasZoomBehavior: boolean
    transientFrameCount: number
    hasTooltip: boolean
  } {
    const visibilityStats = this.visibility.getStats()
    return {
      expandedNodeCount: visibilityStats.expandedNodeCount,
      visibleNodeCount: visibilityStats.visibleNodeCount,
      hasSimulation: this.simulation !== null,
      hasSvg: this.svgEl !== null,
      hasZoomBehavior: this.zoomBehavior !== null,
      transientFrameCount: this.transientFrameIds.size,
      hasTooltip: this.tooltip !== null,
    }
  }

  revealAndSelect(id: string, animate = false, center = false): void {
    this.visibility.revealAndSelect(id, animate)
    if (center) {
      setTimeout(() => this.centerOnNode(id), 300)
    }
  }

  selectNode(id: string, center = false): void {
    this.visibility.selectNode(id)
    if (center) {
      setTimeout(() => this.centerOnNode(id), 300)
    }
  }

  clearSelection(skipVisibilityUpdate = false): void {
    this.visibility.clearSelection(skipVisibilityUpdate)
  }

  reinitializeVisibility(): void {
    this.visibility.initializeSectionVisibility()
  }

  setSearchMatches(ids: Set<string>): void {
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node')
      .classed('search-match', (d) => ids.has(d.data.id))
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

  private renderGraph(): void {
    if (!this.data) return
    this.clear()

    const { nodes: rawNodes } = this.data
    if (rawNodes.length === 0) {
      this.container.innerHTML = '<div class="tapestry-empty">No tapestry: fibers found</div>'
      return
    }

    const containerRect = this.container.getBoundingClientRect()
    const width = Math.max(containerRect.width || 800, 800)
    const height = Math.max(containerRect.height || 600, 600)

    const { hasSections, simNodes, simLinks, simulation } = buildTapestryDagLayout({ data: this.data, width, height })
    this.simulation = simulation

    const svg = d3Selection.select(this.container)
      .append('svg')
      .attr('class', 'tapestry-svg') as d3Selection.Selection<SVGSVGElement, unknown, null, undefined>

    const defs = svg.append('defs')
    const fogFilter = defs.append('filter')
      .attr('id', 'fog-blur')
      .attr('x', '-20%')
      .attr('y', '-20%')
      .attr('width', '140%')
      .attr('height', '140%')
    fogFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '2')

    const rootGroup = svg.append('g')
    const zoomBehavior = d3Zoom.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        rootGroup.attr('transform', event.transform)
      })

    svg.call(zoomBehavior)
    this.svgEl = svg
    this.zoomBehavior = zoomBehavior

    svg.on('click', (event) => {
      if (event.target === svg.node() || event.target.tagName === 'rect') {
        if (this.visibility.hasExpandedNodes()) {
          this.visibility.collapseAll({ x: 0, y: 0 })
          this.clearSelection(true)
        } else {
          this.clearSelection()
        }
      }
    })

    const edgeGroup = rootGroup.append('g').attr('class', 'tapestry-edges')
    const edgePaths: SVGPathSelection[] = []

    simLinks.forEach((link) => {
      const color = stalenessColor(link.target.data.staleness)
      const edgeRand = seededRandom(hashString(link.source.data.id + link.target.data.id))
      const tension = 0.35 + edgeRand() * 0.15
      const sagMagnitude = edgeRand() * 0.18 + 0.06
      const edgeSeed = edgeRand()
      const wobble1 = (edgeRand() - 0.5) * 10
      const wobble2 = (edgeRand() - 0.5) * 10

      for (let strandIndex = 0; strandIndex < RING_COUNT; strandIndex++) {
        const strandOpacity = ringOpacity(strandIndex) * 0.4
        const path = edgeGroup.append('path')
          .datum({ link, strandIndex, tension, sagMagnitude, edgeSeed, wobble1, wobble2, sagPos: 0 })
          .attr('class', 'tapestry-link')
          .attr('stroke', color)
          .attr('stroke-width', 1)
          .attr('stroke-opacity', strandOpacity)
          .attr('stroke-linecap', 'round') as SVGPathSelection
        edgePaths.push(path)
      }
    })

    const knockoutGroup = rootGroup.append('g').attr('class', 'tapestry-knockouts')
    const nodeGroup = rootGroup.append('g').attr('class', 'tapestry-nodes')
    let draggedDistance = 0
    const draggingNodes = new Set<string>()
    const hoverDelay = 300
    let hoverTimer: ReturnType<typeof setTimeout> | null = null

    const nodeElements = nodeGroup.selectAll<SVGGElement, SimNode>('.tapestry-node')
      .data(simNodes)
      .enter()
      .append('g')
      .attr('class', 'tapestry-node')
      .call(d3Drag.drag<SVGGElement, SimNode>()
        .on('start', (event, node) => {
          draggedDistance = 0
          draggingNodes.add(node.data.id)
          if (!event.active) this.simulation?.alphaTarget(0.1).restart()
          node.fx = node.x
          node.fy = node.y
          d3Selection.select(event.sourceEvent.target.closest('.tapestry-node') as Element)
            .style('cursor', 'grabbing')
        })
        .on('drag', (event, node) => {
          draggedDistance += Math.abs(event.dx) + Math.abs(event.dy)
          node.fx = event.x
          node.fy = event.y
        })
        .on('end', (event, node) => {
          draggingNodes.delete(node.data.id)
          if (!event.active) this.simulation?.alphaTarget(0)
          node.fx = node.x
          node.fy = node.y
          d3Selection.select(event.sourceEvent.target.closest('.tapestry-node') as Element)
            .style('cursor', 'grab')

          if (draggedDistance >= 5) return
          if (hoverTimer) {
            clearTimeout(hoverTimer)
            hoverTimer = null
          }
          if (this.tooltip) this.tooltip.style.display = 'none'

          if (hasSections) {
            this.visibility.toggleExpanded(node.data.id, { x: node.x ?? 0, y: node.y ?? 0 }, true)
          }

          if (this.visibility.isSelected(node.data.id)) {
            this.clearSelection()
            return
          }
          this.selectNode(node.data.id)
          setTimeout(() => this.centerOnNode(node.data.id), 50)
        }))

    nodeElements
      .on('mouseenter', (event: MouseEvent, node: SimNode) => {
        const clientX = event.clientX
        const clientY = event.clientY
        hoverTimer = setTimeout(() => {
          const lead = leadParagraph(node.data.body)
          const outcome = node.data.outcome?.trim() ?? ''
          if (this.tooltip) {
            let html = `<span class="tooltip-title">${escapeHtml(node.data.name)}</span>`
            if (lead || outcome) html += '<hr class="tooltip-divider">'
            if (lead) html += `<span class="tooltip-lead">${escapeHtml(lead)}</span>`
            if (lead && outcome) html += '<hr class="tooltip-divider">'
            if (outcome) html += `<span class="tooltip-outcome">${escapeHtml(outcome)}</span>`
            this.tooltip.innerHTML = html
            this.tooltip.style.display = 'block'
            this.tooltip.style.left = `${clientX + 14}px`
            this.tooltip.style.top = `${clientY - 8}px`
          }
        }, hoverDelay)
      })
      .on('mousemove', (event: MouseEvent) => {
        if (!this.tooltip || this.tooltip.style.display === 'none') return
        this.tooltip.style.left = `${event.clientX + 14}px`
        this.tooltip.style.top = `${event.clientY - 8}px`
      })
      .on('mouseleave', () => {
        if (hoverTimer) {
          clearTimeout(hoverTimer)
          hoverTimer = null
        }
        if (this.tooltip) this.tooltip.style.display = 'none'
      })

    renderDagNodeVisuals(nodeElements, knockoutGroup, rawNodes, hasSections)

    this.simulation.on('tick', () => {
      if (!svg.attr('viewBox')) {
        const viewPad = 40
        const minNodeX = Math.min(...simNodes.map((node) => node.x!)) - NODE_RX - viewPad
        const minNodeY = Math.min(...simNodes.map((node) => node.y!)) - NODE_RY - viewPad
        const maxNodeX = Math.max(...simNodes.map((node) => node.x!)) + NODE_RX + viewPad
        const maxNodeY = Math.max(...simNodes.map((node) => node.y!)) + NODE_RY + viewPad
        svg.attr('viewBox', `${minNodeX} ${minNodeY} ${maxNodeX - minNodeX} ${maxNodeY - minNodeY}`)
      }

      nodeElements.attr('transform', (node) => `translate(${node.x}, ${node.y})`)
      knockoutGroup.selectAll<SVGPathElement, SimNode>('.tapestry-knockout')
        .attr('transform', (node) => `translate(${node.x}, ${node.y})`)
      edgePaths.forEach((path) => updateDagEdgePath(path, simNodes, draggingNodes))
    })

    if (hasSections) {
      this.visibility.initializeSectionVisibility()
    }

    this.simulation.alpha(0.03).restart()
    this.flutterTick = () => {
      edgePaths.forEach((path) => updateDagEdgePath(path, simNodes, draggingNodes))
    }
    this.startFlutter()
  }

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

  private centerOnNode(id: string): void {
    if (!this.svgEl || !this.zoomBehavior) return
    let nodePos: { x: number; y: number } | null = null
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each((node) => {
      if (node.data.id === id) nodePos = { x: node.x ?? 0, y: node.y ?? 0 }
    })
    if (!nodePos) return

    const svgRect = (this.svgEl.node() as SVGElement).getBoundingClientRect()
    const sidebar = document.querySelector('.tapestry-sidebar') as HTMLElement | null
    const sidebarWidth = sidebar?.classList.contains('expanded') ? sidebar.getBoundingClientRect().width : 0
    const visibleCenterX = (svgRect.width - sidebarWidth) / 2
    const visibleCenterY = svgRect.height / 2
    const { x, y } = nodePos

    this.svgEl.transition().duration(700).ease(easeCubicInOut)
      .call(this.zoomBehavior.translateTo, x, y, [visibleCenterX, visibleCenterY])
  }
}
