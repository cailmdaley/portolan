import * as d3Force from 'd3-force'
import type { SimLink, SimNode, TapestryResponse } from './tapestry-types'
import {
  INTERIOR_DEPTH_NUDGE,
  isSectionNode,
  NODE_RX,
  SIMULATION_TICKS,
} from './tapestry-helpers'

interface TapestryDagLayoutOptions {
  data: TapestryResponse
  width: number
  height: number
}

interface TapestryDagLayout {
  hasSections: boolean
  simNodes: SimNode[]
  simLinks: SimLink[]
  simulation: d3Force.Simulation<SimNode, SimLink>
}

export function buildTapestryDagLayout(options: TapestryDagLayoutOptions): TapestryDagLayout {
  const { data, width, height } = options
  const { nodes: rawNodes, links: rawLinks } = data
  const depthMap = new Map<string, number>()
  const nodeMap = new Map(rawNodes.map((node) => [node.id, node]))

  const computeDepth = (id: string, visited = new Set<string>()): number => {
    if (depthMap.has(id)) return depthMap.get(id)!
    if (visited.has(id)) return 0
    visited.add(id)
    const node = nodeMap.get(id)
    if (!node || node.dependsOn.length === 0) {
      depthMap.set(id, 0)
      return 0
    }
    const maxDependencyDepth = Math.max(...node.dependsOn.map((depId) => computeDepth(depId, visited)))
    const depth = maxDependencyDepth + 1
    depthMap.set(id, depth)
    return depth
  }

  rawNodes.forEach((node) => computeDepth(node.id))

  const hasSections = rawNodes.some((node) => isSectionNode(node))
  const sectionNodes = rawNodes
    .filter((node) => isSectionNode(node))
    .sort((a, b) => {
      const aDepth = depthMap.get(a.id) || 0
      const bDepth = depthMap.get(b.id) || 0
      return aDepth !== bDepth ? aDepth - bDepth : a.id.localeCompare(b.id)
    })

  const sectionXTarget = new Map<string, number>()
  sectionNodes.forEach((node, index) => {
    sectionXTarget.set(node.id, width * (index + 1) / (sectionNodes.length + 1))
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

  const simulation = d3Force.forceSimulation<SimNode>(simNodes)
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
    simulation.tick()
  }

  simulation.force('y', null)
  simulation.alphaDecay(0.05)
  simulation.velocityDecay(0.9)
  simNodes.forEach((node) => {
    node.fx = node.x
    node.fy = node.y
  })

  centerSimNodes(simNodes, width, height)

  return { hasSections, simNodes, simLinks, simulation }
}

function centerSimNodes(simNodes: SimNode[], width: number, height: number): void {
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
}
