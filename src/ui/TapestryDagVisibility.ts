import * as d3Selection from 'd3-selection'
import { stalenessColor, isSectionNode } from './tapestry-helpers'
import type { EdgeDatum, SimNode, TapestryResponse } from './tapestry-types'

interface TapestryDagVisibilityOptions {
  getData: () => TapestryResponse | null
  getInitialRevealThreshold: () => number
  onSelectNode: (id: string) => void
  onClearSelection: () => void
  requestTransientFrame: (callback: FrameRequestCallback) => number
  restartSimulation: () => void
}

export class TapestryDagVisibility {
  private getData: () => TapestryResponse | null
  private getInitialRevealThreshold: () => number
  private onSelectNode: (id: string) => void
  private onClearSelection: () => void
  private requestTransientFrame: (callback: FrameRequestCallback) => number
  private restartSimulation: () => void
  private expandedNodes = new Set<string>()
  private visibleNodes = new Set<string>()
  private selectedNodeId: string | null = null

  constructor(options: TapestryDagVisibilityOptions) {
    this.getData = options.getData
    this.getInitialRevealThreshold = options.getInitialRevealThreshold
    this.onSelectNode = options.onSelectNode
    this.onClearSelection = options.onClearSelection
    this.requestTransientFrame = options.requestTransientFrame
    this.restartSimulation = options.restartSimulation
  }

  reset(): void {
    this.selectedNodeId = null
    this.expandedNodes.clear()
    this.visibleNodes.clear()
  }

  getStats(): { expandedNodeCount: number; visibleNodeCount: number } {
    return {
      expandedNodeCount: this.expandedNodes.size,
      visibleNodeCount: this.visibleNodes.size,
    }
  }

  hasExpandedNodes(): boolean {
    return this.expandedNodes.size > 0
  }

  isExpanded(id: string): boolean {
    return this.expandedNodes.has(id)
  }

  isSelected(id: string): boolean {
    return this.selectedNodeId === id
  }

  isVisible(id: string): boolean {
    return this.visibleNodes.has(id)
  }

  revealAndSelect(id: string, animate = false): void {
    if (!this.visibleNodes.has(id)) {
      this.expandedNodes.add(id)
      let waveCenter: { x: number; y: number } | undefined
      if (animate) {
        d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node').each((node) => {
          if (node.data.id === id) waveCenter = { x: node.x ?? 0, y: node.y ?? 0 }
        })
      }
      this.updateTierVisibility(animate, waveCenter)
    }
    this.selectNode(id)
  }

  selectNode(id: string): void {
    this.selectedNodeId = id
    this.updateHighlighting()
    this.onSelectNode(id)
  }

  clearSelection(skipVisibilityUpdate = false): void {
    this.selectedNodeId = null
    if (!skipVisibilityUpdate) this.updateTierVisibility()

    const visibleNodes = this.visibleNodes
    d3Selection.selectAll<SVGGElement, SimNode>('.tapestry-node')
      .classed('selected', false)
      .each(function (node) {
        if (visibleNodes.has(node.data.id)) {
          d3Selection.select(this).style('opacity', '1')
        }
      })

    d3Selection.selectAll<SVGPathElement, EdgeDatum>('.tapestry-link').each(function (edge) {
      d3Selection.select(this)
        .attr('stroke-opacity', 0.3)
        .attr('stroke', stalenessColor(edge.link.target.data.staleness))
        .attr('stroke-width', 1)
    })

    this.onClearSelection()
  }

  toggleExpanded(id: string, center: { x: number; y: number }, animate: boolean): void {
    if (this.expandedNodes.has(id)) {
      this.expandedNodes.delete(id)
      this.updateTierVisibility(false, center)
      return
    }
    this.expandedNodes.add(id)
    this.updateTierVisibility(animate, center)
  }

  collapseAll(center?: { x: number; y: number }): void {
    this.expandedNodes.clear()
    this.updateTierVisibility(false, center)
  }

  initializeSectionVisibility(): void {
    this.expandedNodes.clear()
    this.visibleNodes.clear()
    const data = this.getData()
    if (data) {
      const threshold = this.getInitialRevealThreshold()
      for (const node of data.nodes) {
        if ((node.evidence?.mtime ?? Number.NEGATIVE_INFINITY) > threshold) {
          this.expandedNodes.add(node.id)
        }
      }
    }
    this.updateTierVisibility()
  }

  private updateTierVisibility(animate = false, center?: { x: number; y: number }): void {
    const data = this.getData()
    if (!data) return
    const allNodes = data.nodes
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
        element.style('display', '').style('opacity', '').style('pointer-events', '').style('filter', '')
      } else if (animate && becomingFog.has(node.data.id)) {
        // Will be animated by collapseNodesRadial
      } else {
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
      if (sourceVisible && targetVisible) {
        element.style('display', '').style('opacity', null)
      } else if (animate && (becomingFog.has(edge.link.source.data.id) || becomingFog.has(edge.link.target.data.id))) {
        // Will be animated
      } else {
        element.style('display', '').style('opacity', '0.04')
      }
    })

    if (animate && newlyVisible.size > 0 && center) {
      this.revealNodesRadial(center, newlyVisible)
    }
    if (becomingFog.size > 0 && center) {
      this.collapseNodesRadial(becomingFog)
    }

    this.restartSimulation()
  }

  private revealNodesRadial(center: { x: number; y: number }, newlyVisible: Set<string>): void {
    if (newlyVisible.size === 0) return
    const data = this.getData()
    if (!data) return

    const expandSpeed = 420
    const rolloff = 60
    const fogOpacity = 0.09
    const smoothstep = (t: number) => {
      const clamped = Math.max(0, Math.min(1, t))
      return clamped * clamped * (3 - 2 * clamped)
    }

    const nodeMap = new Map(data.nodes.map((node) => [node.id, node]))
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

      const nodeLag = 0.9
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

  private updateHighlighting(): void {
    const data = this.getData()
    if (!this.selectedNodeId || !data) return

    const selectedId = this.selectedNodeId
    const connectedNodes = new Set([selectedId])
    data.nodes.forEach((node) => {
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
