import * as d3Drag from 'd3-drag'
import * as d3Force from 'd3-force'
import * as d3Selection from 'd3-selection'
import * as d3Zoom from 'd3-zoom'
import 'd3-transition'
import { easeCubicInOut } from 'd3-ease'
import { renderDagNodeVisuals, updateDagEdgePath } from './TapestryDagRendering'
import { escapeHtml } from './utils'
import type { EdgeDatum, SimLink, SimNode, SVGPathSelection, TapestryResponse } from './tapestry-types'
import {
  hashString,
  INTERIOR_DEPTH_NUDGE,
  isSectionNode,
  leadParagraph,
  NODE_RX,
  NODE_RY,
  RING_COUNT,
  ringOpacity,
  seededRandom,
  SIMULATION_TICKS,
  stalenessColor,
} from './tapestry-helpers'

interface TapestryDagGraphOptions {
  container: HTMLElement
  onSelectNode: (id: string) => void
  onClearSelection: () => void
}

export class TapestryDagGraph {
  private container: HTMLElement
  private onSelectNode: (id: string) => void
  private onClearSelection: () => void
  private data: TapestryResponse | null = null
  private simulation: d3Force.Simulation<SimNode, SimLink> | null = null
  private svgEl: d3Selection.Selection<SVGSVGElement, unknown, null, undefined> | null = null
  private zoomBehavior: d3Zoom.ZoomBehavior<SVGSVGElement, unknown> | null = null
  private expandedNodes = new Set<string>()
  private visibleNodes = new Set<string>()
  private selectedNodeId: string | null = null
  private flutterRAF: number | null = null
  private flutterTick: (() => void) | null = null
  private transientFrameIds = new Set<number>()
  private tooltip: HTMLElement | null = null

  constructor(options: TapestryDagGraphOptions) {
    this.container = options.container
    this.onSelectNode = options.onSelectNode
    this.onClearSelection = options.onClearSelection
    this.tooltip = document.createElement('div')
    this.tooltip.className = 'tapestry-hover-tooltip'
    document.body.appendChild(this.tooltip)
  }

  render(data: TapestryResponse): void {
    this.data = data
    this.selectedNodeId = null
    this.expandedNodes.clear()
    this.visibleNodes.clear()
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
    this.selectedNodeId = null
    this.expandedNodes.clear()
    this.visibleNodes.clear()
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
    return {
      expandedNodeCount: this.expandedNodes.size,
      visibleNodeCount: this.visibleNodes.size,
      hasSimulation: this.simulation !== null,
      hasSvg: this.svgEl !== null,
      hasZoomBehavior: this.zoomBehavior !== null,
      transientFrameCount: this.transientFrameIds.size,
      hasTooltip: this.tooltip !== null,
    }
  }

  revealAndSelect(id: string, animate = false, center = false): void {
    if (!this.visibleNodes.has(id)) {
      this.expandedNodes.add(id)
      let waveCenter: { x: number; y: number } | undefined
      if (animate) {
        d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each((d) => {
          if (d.data.id === id) waveCenter = { x: d.x ?? 0, y: d.y ?? 0 }
        })
      }
      this.updateTierVisibility(animate, waveCenter)
    }
    this.selectNode(id, center)
  }

  selectNode(id: string, center = false): void {
    this.selectedNodeId = id
    this.updateHighlighting()
    this.onSelectNode(id)
    if (center) {
      setTimeout(() => this.centerOnNode(id), 300)
    }
  }

  clearSelection(skipVisibilityUpdate = false): void {
    this.selectedNodeId = null
    if (!skipVisibilityUpdate) {
      this.updateTierVisibility()
    }

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

    this.onClearSelection()
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

    const { nodes: rawNodes, links: rawLinks } = this.data
    if (rawNodes.length === 0) {
      this.container.innerHTML = '<div class="tapestry-empty">No tapestry: fibers found</div>'
      return
    }

    const containerRect = this.container.getBoundingClientRect()
    const width = Math.max(containerRect.width || 800, 800)
    const height = Math.max(containerRect.height || 600, 600)

    const depthMap = new Map<string, number>()
    const nodeMap = new Map(rawNodes.map((n) => [n.id, n]))

    const computeDepth = (id: string, visited = new Set<string>()): number => {
      if (depthMap.has(id)) return depthMap.get(id)!
      if (visited.has(id)) return 0
      visited.add(id)
      const node = nodeMap.get(id)
      if (!node || node.dependsOn.length === 0) {
        depthMap.set(id, 0)
        return 0
      }
      const maxDep = Math.max(...node.dependsOn.map((depId) => computeDepth(depId, visited)))
      const depth = maxDep + 1
      depthMap.set(id, depth)
      return depth
    }

    rawNodes.forEach((node) => computeDepth(node.id))

    const hasSections = rawNodes.some((node) => isSectionNode(node))
    const sectionNodesRaw = rawNodes
      .filter((node) => isSectionNode(node))
      .sort((a, b) => {
        const aDepth = depthMap.get(a.id) || 0
        const bDepth = depthMap.get(b.id) || 0
        return aDepth !== bDepth ? aDepth - bDepth : a.id.localeCompare(b.id)
      })

    const sectionXTarget = new Map<string, number>()
    sectionNodesRaw.forEach((node, index) => {
      sectionXTarget.set(node.id, width * (index + 1) / (sectionNodesRaw.length + 1))
    })

    const nearestSectionAnchor = (id: string, visited = new Set<string>()): { x: number; sectionDepth: number } => {
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

    const simNodes: SimNode[] = rawNodes.map((node) => {
      if (hasSections && isSectionNode(node)) {
        const x = sectionXTarget.get(node.id) || width / 2
        return { id: node.id, data: node, degree: 0, x, y: height / 2, fx: x, fy: height / 2 }
      }
      if (hasSections) {
        const { x: sectionX, sectionDepth } = nearestSectionAnchor(node.id)
        const nodeDepth = depthMap.get(node.id) || 0
        const xNudge = Math.max(0, nodeDepth - sectionDepth - 1) * INTERIOR_DEPTH_NUDGE
        return {
          id: node.id,
          data: node,
          degree: 0,
          x: sectionX + xNudge + (Math.random() - 0.5) * 50,
          y: height / 2 + (Math.random() - 0.5) * 160,
        }
      }
      return {
        id: node.id,
        data: node,
        degree: 0,
        x: width / 2 + (Math.random() - 0.5) * 200,
        y: height / 2 + (Math.random() - 0.5) * 200,
      }
    })

    const simNodeMap = new Map(simNodes.map((node) => [node.id, node]))
    const simLinks: SimLink[] = rawLinks
      .map((link) => ({
        source: simNodeMap.get(link.source),
        target: simNodeMap.get(link.target),
      }))
      .filter((link): link is SimLink => Boolean(link.source && link.target))

    simLinks.forEach((link) => {
      link.source.degree++
      link.target.degree++
    })

    this.simulation = d3Force.forceSimulation<SimNode>(simNodes)
      .force('link', d3Force.forceLink<SimNode, SimLink>(simLinks)
        .id((node) => node.id)
        .distance(140)
        .strength(0.7))
      .force('charge', d3Force.forceManyBody().strength(-500).distanceMax(600))
      .force('collide', d3Force.forceCollide<SimNode>()
        .radius((node) => {
          const scale = isSectionNode(node.data) ? 1.5 : 1.25
          return NODE_RX * scale + 8
        })
        .strength(0.9))
      .force('y', d3Force.forceY(height / 2).strength(0.02))
      .alphaDecay(0.012)
      .velocityDecay(0.75)
      .stop()

    for (let index = 0; index < SIMULATION_TICKS; index++) {
      this.simulation.tick()
    }

    this.simulation.force('y', null)
    this.simulation.alphaDecay(0.05)
    this.simulation.velocityDecay(0.9)
    simNodes.forEach((node) => {
      node.fx = node.x
      node.fy = node.y
    })

    const pad = NODE_RX * 2
    const xs = simNodes.map((node) => node.x!)
    const ys = simNodes.map((node) => node.y!)
    const xOffset = (width - (Math.max(...xs) - Math.min(...xs))) / 2 - Math.min(...xs)
    const yOffset = (height - (Math.max(...ys) - Math.min(...ys))) / 2 - Math.min(...ys)
    const clampedXOffset = Math.max(xOffset, pad - Math.min(...xs))
    const clampedYOffset = Math.max(yOffset, pad - Math.min(...ys))
    simNodes.forEach((node) => {
      node.x = node.x! + clampedXOffset
      node.y = node.y! + clampedYOffset
      node.fx = node.x
      node.fy = node.y
    })

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
        if (this.expandedNodes.size > 0) {
          this.expandedNodes.clear()
          this.updateTierVisibility(false, { x: 0, y: 0 })
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
            if (this.expandedNodes.has(node.data.id)) {
              this.expandedNodes.delete(node.data.id)
              this.updateTierVisibility(false, { x: node.x ?? 0, y: node.y ?? 0 })
            } else {
              this.expandedNodes.add(node.data.id)
              this.updateTierVisibility(true, { x: node.x ?? 0, y: node.y ?? 0 })
            }
          }

          if (this.selectedNodeId === node.data.id) {
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
            let html = `<span class="tooltip-title">${escapeHtml(node.data.title)}</span>`
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
      this.expandedNodes.clear()
      this.visibleNodes.clear()
      this.updateTierVisibility()
    }

    this.simulation.alpha(0.03).restart()
    this.flutterTick = () => {
      edgePaths.forEach((path) => updateDagEdgePath(path, simNodes, draggingNodes))
    }
    this.startFlutter()
  }

  private updateTierVisibility(animate = false, center?: { x: number; y: number }): void {
    if (!this.data) return
    const allNodes = this.data.nodes
    if (!allNodes.some((node) => isSectionNode(node))) return

    const visible = new Set<string>()
    allNodes.filter((node) => isSectionNode(node)).forEach((node) => visible.add(node.id))

    for (const nodeId of this.expandedNodes) {
      const node = allNodes.find((candidate) => candidate.id === nodeId)
      if (!node) continue
      visible.add(nodeId)
      node.dependsOn.forEach((depId) => visible.add(depId))
      allNodes.forEach((candidate) => {
        if (candidate.dependsOn.includes(nodeId)) visible.add(candidate.id)
      })
    }

    const newlyVisible = new Set<string>()
    const becomingFog = new Set<string>()
    for (const id of visible) {
      if (!this.visibleNodes.has(id)) newlyVisible.add(id)
    }
    for (const id of this.visibleNodes) {
      if (!visible.has(id)) becomingFog.add(id)
    }
    this.visibleNodes = new Set(visible)

    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (node) {
      const element = d3Selection.select(this)
      if (visible.has(node.data.id)) {
        element.style('display', '').style('pointer-events', '').style('filter', '')
        if (newlyVisible.has(node.data.id) && animate) {
          element.style('opacity', '0')
        }
      } else if (!becomingFog.has(node.data.id)) {
        element.style('display', '').style('opacity', '0.09').style('pointer-events', '').style('filter', 'url(#fog-blur)')
      }
    })

    d3Selection.selectAll<SVGPathElement, SimNode>('.tapestry-knockout').each(function (node) {
      d3Selection.select(this).style('display', visible.has(node.data.id) ? '' : 'none')
    })

    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (edge) {
      const element = d3Selection.select(this)
      const sourceVisible = visible.has(edge.link.source.data.id)
      const targetVisible = visible.has(edge.link.target.data.id)
      const sourceBecomingFog = becomingFog.has(edge.link.source.data.id)
      const targetBecomingFog = becomingFog.has(edge.link.target.data.id)
      if (sourceVisible && targetVisible) {
        element.style('display', '').style('opacity', null)
      } else if (!sourceBecomingFog && !targetBecomingFog) {
        element.style('display', '').style('opacity', '0.04')
      }
    })

    if (animate && newlyVisible.size > 0 && center) {
      this.revealNodesRadial(center, newlyVisible)
    }
    if (becomingFog.size > 0 && center) {
      this.collapseNodesRadial(becomingFog)
    }

    this.simulation?.alpha(0.05).restart()
  }

  private revealNodesRadial(center: { x: number; y: number }, newlyVisible: Set<string>): void {
    if (newlyVisible.size === 0 || !this.data) return

    const expandSpeed = 420
    const rolloff = 60
    const fogOpacity = 0.09
    const smoothstep = (t: number) => {
      const clamped = Math.max(0, Math.min(1, t))
      return clamped * clamped * (3 - 2 * clamped)
    }

    const nodeMap = new Map(this.data.nodes.map((node) => [node.id, node]))
    const simPos = new Map<string, { x: number; y: number }>()
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each((node) => {
      simPos.set(node.data.id, { x: node.x ?? 0, y: node.y ?? 0 })
    })

    const nearestSection = (startId: string): { x: number; y: number } | null => {
      const queue = [startId]
      const visited = new Set([startId])
      while (queue.length > 0) {
        const id = queue.shift()!
        const node = nodeMap.get(id)
        if (!node) continue
        if (isSectionNode(node)) return simPos.get(id) ?? null
        for (const depId of node.dependsOn) {
          if (visited.has(depId)) continue
          visited.add(depId)
          queue.push(depId)
        }
      }
      return null
    }

    let waveOrigin = center
    for (const id of newlyVisible) {
      const position = nearestSection(id)
      if (position) {
        waveOrigin = position
        break
      }
    }

    const nodeEls = new Map<string, SVGGElement>()
    const nodeDist = new Map<string, number>()
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (node) {
      if (!newlyVisible.has(node.data.id)) return
      const dx = (node.x ?? 0) - waveOrigin.x
      const dy = (node.y ?? 0) - waveOrigin.y
      nodeDist.set(node.data.id, Math.sqrt(dx * dx + dy * dy))
      nodeEls.set(node.data.id, this)
    })

    interface EdgeReveal {
      el: SVGPathElement
      startDist: number
      span: number
      targetId: string
    }

    const edgeReveals: EdgeReveal[] = []
    const nodeDrivers = new Map<string, EdgeReveal[]>()
    const visibleNodes = this.visibleNodes
    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (edge) {
      const sourceId = edge.link.source.data.id
      const targetId = edge.link.target.data.id
      if (!(newlyVisible.has(sourceId) || newlyVisible.has(targetId))) return
      if (!visibleNodes.has(sourceId) || !visibleNodes.has(targetId)) return
      const sourceDist = Math.sqrt(((edge.link.source.x ?? 0) - waveOrigin.x) ** 2 + ((edge.link.source.y ?? 0) - waveOrigin.y) ** 2)
      const targetDist = Math.sqrt(((edge.link.target.x ?? 0) - waveOrigin.x) ** 2 + ((edge.link.target.y ?? 0) - waveOrigin.y) ** 2)
      const length = this.getTotalLength()
      this.style.opacity = ''
      this.style.strokeDasharray = `0 ${length}`
      this.style.strokeDashoffset = '0'
      const reveal: EdgeReveal = {
        el: this,
        startDist: sourceDist,
        span: Math.max(targetDist - sourceDist, 1),
        targetId,
      }
      edgeReveals.push(reveal)
      if (!newlyVisible.has(targetId)) return
      if (!nodeDrivers.has(targetId)) nodeDrivers.set(targetId, [])
      nodeDrivers.get(targetId)!.push(reveal)
    })

    const allDists = [...nodeDist.values(), ...edgeReveals.map((reveal) => reveal.startDist + reveal.span)]
    const maxDist = allDists.length > 0 ? Math.max(...allDists) : 0
    const totalDuration = ((maxDist + rolloff) / expandSpeed) * 1000
    const start = performance.now()

    const tick = (now: number) => {
      const waveRadius = ((now - start) / 1000) * expandSpeed
      const fractionOf = new Map<EdgeReveal, number>()
      for (const reveal of edgeReveals) {
        const fraction = smoothstep((waveRadius - reveal.startDist) / reveal.span)
        fractionOf.set(reveal, fraction)
        const length = reveal.el.getTotalLength()
        reveal.el.style.strokeDasharray = `${fraction * length} ${length}`
      }

      const nodeLag = 0.90
      for (const [nodeId, element] of nodeEls) {
        const drivers = nodeDrivers.get(nodeId)
        let fraction: number
        if (drivers && drivers.length > 0) {
          const edgeFraction = Math.max(...drivers.map((reveal) => fractionOf.get(reveal) ?? 0))
          fraction = smoothstep((edgeFraction - nodeLag) / (1 - nodeLag))
        } else {
          fraction = smoothstep((waveRadius - (nodeDist.get(nodeId) ?? 0)) / rolloff)
        }
        element.style.opacity = String(fogOpacity + (1 - fogOpacity) * fraction)
      }

      if (now - start < totalDuration) {
        this.requestTransientFrame(tick)
      } else {
        for (const element of nodeEls.values()) element.style.opacity = '1'
        for (const reveal of edgeReveals) {
          reveal.el.style.strokeDasharray = ''
          reveal.el.style.strokeDashoffset = ''
        }
      }
    }

    this.requestTransientFrame(tick)
  }

  private collapseNodesRadial(becomingFog: Set<string>): void {
    if (becomingFog.size === 0) return

    const fadeDuration = 380
    const fogOpacity = 0.09
    const smoothstep = (t: number) => {
      const clamped = Math.max(0, Math.min(1, t))
      return clamped * clamped * (3 - 2 * clamped)
    }

    const nodeEls = new Map<string, { el: SVGGElement; fromOpacity: number }>()
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (node) {
      if (!becomingFog.has(node.data.id)) return
      const fromOpacity = parseFloat(this.style.opacity || '1')
      this.style.filter = 'url(#fog-blur)'
      nodeEls.set(node.data.id, { el: this, fromOpacity })
    })

    const edgeEls: Array<{ el: SVGPathElement; fromOpacity: number }> = []
    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (edge) {
      if (!(becomingFog.has(edge.link.source.data.id) || becomingFog.has(edge.link.target.data.id))) return
      const fromOpacity = parseFloat(this.style.opacity || '1')
      this.style.strokeDasharray = ''
      this.style.strokeDashoffset = ''
      edgeEls.push({ el: this, fromOpacity })
    })

    const start = performance.now()
    const tick = (now: number) => {
      const fraction = smoothstep(Math.min((now - start) / fadeDuration, 1))
      for (const { el, fromOpacity } of nodeEls.values()) {
        el.style.opacity = String(fromOpacity + (fogOpacity - fromOpacity) * fraction)
      }
      for (const edge of edgeEls) {
        edge.el.style.opacity = String(edge.fromOpacity + (0.04 - edge.fromOpacity) * fraction)
      }

      if (now - start < fadeDuration) {
        this.requestTransientFrame(tick)
      } else {
        for (const { el } of nodeEls.values()) el.style.opacity = String(fogOpacity)
        for (const edge of edgeEls) edge.el.style.opacity = '0.04'
      }
    }

    this.requestTransientFrame(tick)
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

  private updateHighlighting(): void {
    if (!this.selectedNodeId || !this.data) return
    const selectedId = this.selectedNodeId
    const connectedNodes = new Set([selectedId])
    this.data.nodes.forEach((node) => {
      if (node.id === selectedId) {
        node.dependsOn.forEach((depId) => connectedNodes.add(depId))
      }
      if (node.dependsOn.includes(selectedId)) {
        connectedNodes.add(node.id)
      }
    })

    const visibleNodes = this.visibleNodes
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each(function (node) {
      if (!visibleNodes.has(node.data.id)) return
      const element = d3Selection.select(this)
      const isSelected = node.data.id === selectedId
      const isConnected = connectedNodes.has(node.data.id)
      const opacity = isSelected ? 1.0 : isConnected ? 0.7 : 0.3
      element.classed('selected', isSelected).style('opacity', String(opacity))
    })

    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (edge) {
      const sourceId = edge.link.source.data.id
      const targetId = edge.link.target.data.id
      const touchesSelected = sourceId === selectedId || targetId === selectedId
      d3Selection.select(this)
        .attr('stroke-opacity', touchesSelected ? 0.75 : 0.3)
        .attr('stroke', stalenessColor(edge.link.target.data.staleness))
        .attr('stroke-width', 1)
    })
  }
}
