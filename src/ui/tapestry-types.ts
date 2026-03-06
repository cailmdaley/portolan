import type * as d3Force from 'd3-force'
import type * as d3Selection from 'd3-selection'
import type { BaseAnnotation } from './AnnotationPanel'

export interface TapestryNode {
  id: string
  title: string
  kind: string
  status: string
  body: string
  outcome: string | null
  tags: string[]
  createdAt: string | null
  closedAt: string | null
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

export interface TapestryLink {
  source: string
  target: string
}

export interface TapestryFiber {
  id: string
  title: string
  status: string
  kind: string
  tags?: string[]
  body?: string
  outcome?: string | null
  createdAt?: string | null
  closedAt?: string | null
  dependsOn: string[]
}

export interface TapestryResponse {
  nodes: TapestryNode[]
  links: TapestryLink[]
  downstream: Record<string, Array<{ id: string; title: string; status: string; kind: string }>>
  config: Record<string, string> | null
  fibers?: TapestryFiber[]
}

/** D3 simulation node with position. */
export interface SimNode extends d3Force.SimulationNodeDatum {
  id: string
  data: TapestryNode
  degree: number
}

/** D3 simulation link with resolved node references. */
export interface SimLink extends d3Force.SimulationLinkDatum<SimNode> {
  source: SimNode
  target: SimNode
}

export type SVGPathSelection = d3Selection.Selection<SVGPathElement, unknown, null, undefined>

export interface EdgeDatum {
  link: SimLink
  strandIndex: number
  tension: number
  sagMagnitude: number
  edgeSeed: number
  wobble1: number
  wobble2: number
  sagPos: number
}

export interface ClaimsAnnotation extends BaseAnnotation {
  claimId: string
  claimTitle?: string
  selectedText?: string
  artifact?: string
  x?: number
  y?: number
  line?: number
  endLine?: number
  filePath?: string
  isImageAnnotation?: boolean
}

export type Staleness = TapestryNode['staleness']
