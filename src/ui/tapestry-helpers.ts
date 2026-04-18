import { STALENESS_COLORS } from './utils'
import type { TapestryNode, TapestryDecision, TapestryResponse, Staleness } from './tapestry-types'

// ── Layout constants ────────────────────────────────────────────────

export const NODE_RX = 52
export const NODE_RY = 21
export const INTERIOR_DEPTH_NUDGE = 60
export const RING_SCALES = [1.0, 1.15]
export const RING_COUNT = RING_SCALES.length
export const SIMULATION_TICKS = 800

// ── Staleness & status ──────────────────────────────────────────────

export function stalenessColor(staleness: Staleness): string {
  return STALENESS_COLORS[staleness] || STALENESS_COLORS['no-evidence']
}

const DOT_STALENESS_COLORS: Record<string, string> = {
  fresh:        '#215838',
  stale:        '#74232e',
  'no-evidence': '#443e38',
}

export function dotStalenessColor(staleness: string): string {
  return DOT_STALENESS_COLORS[staleness] ?? DOT_STALENESS_COLORS['no-evidence']
}

export function stalenessIcon(staleness: Staleness): string {
  if (staleness === 'fresh') return '\u25CF'
  if (staleness === 'stale') return '\u25CC'
  return '\u25CB'
}

export function statusIcon(status: string): string {
  if (status === 'closed') return '\u25CF'
  if (status === 'active') return '\u25D0'
  return '\u25CB'
}

export function isSectionNode(node: TapestryNode): boolean {
  return node.tags.some(t => t === 'tier:1')
}

// ── Artifact helpers ────────────────────────────────────────────────

export function artifactEntries(artifacts: Record<string, string>): [string, string][] {
  return Object.entries(artifacts)
}

export function isPdfArtifact(path: string): boolean {
  return /\.pdf(?:$|[?#])/i.test(path)
}

// ── Procedural geometry ─────────────────────────────────────────────

export function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

export function seededRandom(seed: number): () => number {
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

export function organicEllipse(rx: number, ry: number, seed: number, scale = 1): string {
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

export function ringOpacity(index: number): number {
  return 0.9 * (1 - index / (RING_SCALES.length * 3))
}

export function ellipsePoint(cx: number, cy: number, rx: number, ry: number, theta: number): { x: number; y: number } {
  return {
    x: cx + rx * Math.cos(theta),
    y: cy + ry * Math.sin(theta),
  }
}

// ── Decision helpers ────────────────────────────────────────────────

export type DecisionStatus = 'resolved' | 'open' | 'suspicious'

/** Find decisions relevant to a section node (tier:1) by checking if any
 *  evidenceIds are in this section's subtree (the node itself + its downstream). */
export function decisionsForSection(
  node: TapestryNode,
  data: TapestryResponse,
): TapestryDecision[] {
  if (!data.decisions?.length) return []
  const subtreeIds = new Set<string>()
  subtreeIds.add(node.id)
  const downstream = data.downstream[node.id] || []
  for (const d of downstream) subtreeIds.add(d.id)
  // Also include nodes that depend on this section node
  for (const n of data.nodes) {
    if (n.dependsOn.includes(node.id)) subtreeIds.add(n.id)
  }
  return data.decisions.filter(
    (dec) => dec.evidenceIds.some((eid) => subtreeIds.has(eid)),
  )
}

/** Derive decision status from its evidence nodes. */
export function decisionStatus(
  decision: TapestryDecision,
  nodes: TapestryNode[],
): DecisionStatus {
  if (decision.evidenceIds.length === 0) return 'open'
  const evidenceNodes = decision.evidenceIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter(Boolean) as TapestryNode[]
  if (evidenceNodes.length === 0) return 'open'
  const allClosed = evidenceNodes.every((n) => n.status === 'closed' && n.outcome)
  if (allClosed) {
    // Check if any outcome hints at uncertainty
    const suspicious = evidenceNodes.some((n) =>
      /\b(suspicious|uncertain|todo|open question|unresolved)\b/i.test(n.outcome || ''),
    )
    return suspicious ? 'suspicious' : 'resolved'
  }
  return 'open'
}

export function decisionStatusIcon(status: DecisionStatus): string {
  if (status === 'resolved') return '\u2713'
  if (status === 'suspicious') return '?'
  return '\u25CB'
}

/** Get the primary verdict for a decision — the outcome of its first evidence node. */
export function decisionVerdict(
  decision: TapestryDecision,
  nodes: TapestryNode[],
): string | null {
  for (const id of decision.evidenceIds) {
    const node = nodes.find((n) => n.id === id)
    if (node?.outcome) return node.outcome
  }
  return null
}

// ── Text helpers ────────────────────────────────────────────────────

export function shortName(title: string): string {
  const clean = title.replace(/-[a-f0-9]{8}$/, '')
  const words = clean.replace(/[-_]/g, ' ').split(' ').filter(w => w)
  return words.slice(0, 3).join(' ')
}

export function leadParagraph(body: string): string {
  if (!body) return ''
  const stripped = body
    .replace(/^#{1,6}\s+.*/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, s => s.slice(1, -1))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
  const firstPara = stripped.split(/\n\n+/).find(p => p.trim().length > 10) ?? stripped
  const sentences = firstPara.match(/[^.!?]*[.!?]+/g) ?? []
  if (sentences.length >= 2) return sentences.slice(0, 2).join('').trim()
  if (sentences.length === 1) return sentences[0].trim()
  return firstPara.slice(0, 160).trim() + (firstPara.length > 160 ? '\u2026' : '')
}

// ── DAG neighbor analysis ───────────────────────────────────────────

export function splitNeighborFibers(nodeId: string, allNodes: TapestryNode[]): {
  upstream: Array<{ id: string; staleness: TapestryNode['staleness'] }>
  downstream: Array<{ id: string; staleness: TapestryNode['staleness'] }>
} {
  const node = allNodes.find(n => n.id === nodeId)
  const toFiber = (id: string) => {
    const n = allNodes.find(x => x.id === id)
    return n ? { id, staleness: n.staleness } : null
  }
  const upstream = (node?.dependsOn ?? []).map(toFiber).filter(Boolean) as Array<{ id: string; staleness: TapestryNode['staleness'] }>
  const downstream = allNodes
    .filter(n => n.dependsOn.includes(nodeId) && n.id !== nodeId)
    .map(n => ({ id: n.id, staleness: n.staleness }))
  return { upstream, downstream }
}
