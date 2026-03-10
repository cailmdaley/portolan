import * as d3Selection from 'd3-selection'
import type { EdgeDatum, SimNode, SVGPathSelection, TapestryNode } from './tapestry-types'
import {
  dotStalenessColor,
  ellipsePoint,
  hashString,
  isSectionNode,
  NODE_RX,
  NODE_RY,
  organicEllipse,
  ringOpacity,
  RING_COUNT,
  RING_SCALES,
  shortName,
  splitNeighborFibers,
} from './tapestry-helpers'

export function renderDagNodeVisuals(
  nodeElements: d3Selection.Selection<SVGGElement, SimNode, SVGGElement, unknown>,
  knockoutGroup: d3Selection.Selection<SVGGElement, unknown, null, undefined>,
  rawNodes: TapestryNode[],
  hasSections: boolean,
): void {
  nodeElements.each((node, index, nodes) => {
    const group = d3Selection.select(nodes[index])
    const nodeHash = hashString(node.data.id)
    const paletteColors = ['#2E5252', '#6B3838', '#8C9090']
    const color = paletteColors[nodeHash % paletteColors.length]
    const nodeSeed = nodeHash / 1000000
    const isSection = isSectionNode(node.data)
    const nodeScale = isSection && hasSections ? 1.5 : 1.25
    const rx = NODE_RX * nodeScale
    const ry = NODE_RY * nodeScale

    if (isSection) group.classed('tapestry-section-node', true)

    knockoutGroup.append('path')
      .datum(node)
      .attr('class', 'tapestry-knockout')
      .attr('d', organicEllipse(rx, ry, nodeSeed, 1.0))
      .attr('fill', '#E8DDD0')
      .attr('fill-opacity', 1.0)
      .attr('stroke', 'none')

    const fillColors = [color, color]
    const fillOpacities = [0.55, 0.18]
    for (let ringIndex = RING_COUNT - 1; ringIndex >= 0; ringIndex--) {
      const scale = RING_SCALES[ringIndex]
      group.append('path')
        .attr('class', 'tapestry-node-fill')
        .attr('d', organicEllipse(rx, ry, nodeSeed + ringIndex * 0.1, scale))
        .attr('fill', fillColors[ringIndex])
        .attr('fill-opacity', fillOpacities[ringIndex])
        .attr('stroke', 'none')
    }

    for (let ringIndex = 0; ringIndex < RING_COUNT; ringIndex++) {
      const scale = RING_SCALES[ringIndex]
      const isCore = ringIndex === 0
      group.append('path')
        .attr('class', 'tapestry-node-ring')
        .attr('d', organicEllipse(rx, ry, nodeSeed + ringIndex * 0.1, scale))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', isCore ? 0.8 : 0.5)
        .attr('stroke-opacity', ringOpacity(ringIndex) * (isCore ? 0.85 : 1))
    }

    const name = shortName(node.data.title)
    const words = name.split(' ')
    const maxTextWidth = rx * (isSection ? 2.0 : 1.7)
    const charWidth = 0.58
    const baseFs = isSection ? 19 : 14
    const fitSize = (lines: string[], base: number) => {
      const longest = Math.max(...lines.map((line) => line.length))
      const needed = longest * charWidth * base
      return needed > maxTextWidth ? Math.max(7, maxTextWidth / (longest * charWidth)) : base
    }

    let lines: string[]
    let textFs: number
    if (words.length <= 1) {
      lines = [name]
      textFs = fitSize(lines, baseFs)
    } else if (words.length === 2) {
      const fsSingle = fitSize([name], baseFs)
      const fsSplit = fitSize([words[0], words[1]], baseFs)
      lines = fsSplit > fsSingle * 1.05 ? [words[0], words[1]] : [name]
      textFs = lines.length > 1 ? fsSplit : fsSingle
    } else {
      const midpoint = Math.ceil(words.length / 2)
      lines = [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')]
      textFs = fitSize(lines, baseFs)
    }

    const lineHeight = textFs * 1.1
    if (lines.length === 1) {
      group.append('text')
        .attr('class', 'tapestry-node-label')
        .attr('y', textFs * 0.35)
        .attr('text-anchor', 'middle')
        .attr('font-size', `${textFs}px`)
        .text(lines[0])
    } else {
      group.append('text')
        .attr('class', 'tapestry-node-label')
        .attr('y', -lineHeight * 0.5 + textFs * 0.35)
        .attr('text-anchor', 'middle')
        .attr('font-size', `${textFs}px`)
        .text(lines[0])
      group.append('text')
        .attr('class', 'tapestry-node-label')
        .attr('y', lineHeight * 0.5 + textFs * 0.35)
        .attr('text-anchor', 'middle')
        .attr('font-size', `${textFs}px`)
        .text(lines[1])
    }

    if (!hasSections) return
    const { upstream, downstream } = splitNeighborFibers(node.data.id, rawNodes)
    const maxSymbols = 6
    const dotFs = 9
    const dotGapTop = 0
    const dotGapBottom = 2
    const ascent = textFs * 0.7
    const descent = textFs * 0.25
    const textTop = lines.length > 1
      ? (-lineHeight * 0.5 + textFs * 0.35) - ascent
      : textFs * 0.35 - ascent
    const textBottom = lines.length > 1
      ? (lineHeight * 0.5 + textFs * 0.35) + descent
      : textFs * 0.35 + descent
    const upstreamY = textTop - dotGapTop - dotFs * 0.25
    const downstreamY = textBottom + dotGapBottom + dotFs * 0.7
    const renderStrip = (fibers: Array<{ id: string; staleness: TapestryNode['staleness'] }>, y: number) => {
      if (fibers.length === 0) return
      const shown = fibers.slice(0, maxSymbols)
      const overflow = fibers.length - maxSymbols
      const strip = group.append('text')
        .attr('y', y)
        .attr('text-anchor', 'middle')
        .attr('font-size', `${dotFs}px`)
        .attr('letter-spacing', '2')
      shown.forEach((fiber) => {
        strip.append('tspan')
          .attr('fill', dotStalenessColor(fiber.staleness))
          .text(fiber.staleness === 'no-evidence' ? '○' : '●')
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
  })
}

export function updateDagEdgePath(
  pathEl: SVGPathSelection,
  simNodes: SimNode[],
  draggingNodes: Set<string>,
): void {
  const datum = pathEl.datum() as EdgeDatum
  const ringScale = RING_SCALES[datum.strandIndex]
  const spreadRange = Math.PI * 0.15
  const angleOffset = (datum.strandIndex - 0.5) * spreadRange
  const baseAngle = Math.atan2(
    datum.link.target.y! - datum.link.source.y!,
    datum.link.target.x! - datum.link.source.x!,
  )
  const start = ellipsePoint(
    datum.link.source.x!,
    datum.link.source.y!,
    NODE_RX * ringScale,
    NODE_RY * ringScale,
    baseAngle + angleOffset,
  )
  const end = ellipsePoint(
    datum.link.target.x!,
    datum.link.target.y!,
    NODE_RX * ringScale,
    NODE_RY * ringScale,
    baseAngle + Math.PI + angleOffset,
  )
  const dx = end.x - start.x
  const dy = end.y - start.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  const tx = dist > 0 ? dx / dist : 1
  const ty = dist > 0 ? dy / dist : 0
  const perpX = -ty
  const perpY = tx
  const sagSign = Math.sin(baseAngle * 2 + datum.edgeSeed * Math.PI * 2) >= 0 ? 1 : -1
  const targetSag = dist * datum.sagMagnitude * sagSign
  const isHeld = draggingNodes.has(datum.link.source.data.id) || draggingNodes.has(datum.link.target.data.id)
  if (isHeld) {
    datum.sagPos += (targetSag - datum.sagPos) * 0.12
  } else {
    datum.sagPos = targetSag
  }
  const sagPos = datum.sagPos
  const gravityY = (datum.link.source.y! / 200) * dist * 0.10
  const leanStrength = dist * 0.07
  const cp1 = {
    x: start.x + tx * dist * datum.tension + perpX * (sagPos + datum.wobble1),
    y: start.y + ty * dist * datum.tension + perpY * (sagPos + datum.wobble1) + gravityY,
  }
  const cp2 = {
    x: end.x - tx * dist * datum.tension + perpX * (sagPos + datum.wobble2) + Math.sin(baseAngle) * leanStrength,
    y: end.y - ty * dist * datum.tension + perpY * (sagPos + datum.wobble2) - Math.cos(baseAngle) * leanStrength,
  }

  const repelRadius = 80
  simNodes.forEach((otherNode) => {
    if (otherNode.data.id === datum.link.source.data.id || otherNode.data.id === datum.link.target.data.id) return
    const otherX = otherNode.x!
    const otherY = otherNode.y!
    for (const controlPoint of [cp1, cp2]) {
      const ddx = controlPoint.x - otherX
      const ddy = controlPoint.y - otherY
      const dd = Math.sqrt(ddx * ddx + ddy * ddy)
      if (dd >= repelRadius || dd === 0) continue
      const strength = (repelRadius - dd) / repelRadius * 30
      controlPoint.x += (ddx / dd) * strength
      controlPoint.y += (ddy / dd) * strength
    }
  })

  pathEl.attr('d', `M${start.x},${start.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${end.x},${end.y}`)
}
