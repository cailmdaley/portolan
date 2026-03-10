import { escapeHtml, formatFiberDate, renderArtifactGallery, renderMarkdown } from './utils'
import type { City } from '../state/types'
import type { TapestryNode, TapestryResponse } from './tapestry-types'
import { shortName, stalenessColor, stalenessIcon, statusIcon } from './tapestry-helpers'

const DETAIL_DEFAULT_WIDTH = 420
const DETAIL_MIN_WIDTH = 280
const DETAIL_MAX_WIDTH = 800

interface TapestryDetailPanelOptions {
  panel: HTMLElement
  detailPanel: HTMLElement
  fiberListEl: HTMLElement
  getCurrentCity: () => City | null
  getTapestryData: () => TapestryResponse | null
  isStaticMode: () => boolean
  getArtifactUrl: (specName: string, filePath: string) => string
  openStaticFile: (href: string, line?: number) => void
  openFileFromLink: (href: string, line?: number) => void
  renderDetailBody: (container: HTMLElement, body: string) => void
  enterBodyEditMode: (node: TapestryNode) => void
  saveBodyAndExit: (node: TapestryNode) => Promise<void>
  exitBodyEditMode: (node: TapestryNode) => void
  navigateToFiber: (fiberId: string) => void
  refreshCurrentNode: () => Promise<void>
  hideDetail: () => void
  openArtifactLightbox: (media: HTMLElement, node: TapestryNode) => void
}

export class TapestryDetailPanel {
  private readonly panel: HTMLElement
  private readonly detailPanel: HTMLElement
  private readonly fiberListEl: HTMLElement
  private readonly options: TapestryDetailPanelOptions

  private detailWidth = DETAIL_DEFAULT_WIDTH
  private galleryDetach: (() => void) | null = null
  private artifactClickHandler: ((e: MouseEvent) => void) | null = null

  constructor(options: TapestryDetailPanelOptions) {
    this.options = options
    this.panel = options.panel
    this.detailPanel = options.detailPanel
    this.fiberListEl = options.fiberListEl
  }

  getRuntimeStats(): {
    hasArtifactClickHandler: boolean
    hasGalleryDetach: boolean
  } {
    return {
      hasArtifactClickHandler: this.artifactClickHandler !== null,
      hasGalleryDetach: this.galleryDetach !== null,
    }
  }

  destroy(): void {
    this.cleanupBindings()
  }

  hide(): void {
    this.cleanupBindings()
    this.detailPanel.classList.add('hidden')
    this.fiberListEl.classList.remove('hidden')
    const sidebar = this.panel.querySelector('.tapestry-sidebar') as HTMLElement | null
    sidebar?.classList.remove('expanded')
    sidebar?.style.removeProperty('width')
  }

  renderNode(nodeId: string): boolean {
    const tapestryData = this.options.getTapestryData()
    if (!tapestryData) return false
    const node = tapestryData.nodes.find((entry) => entry.id === nodeId)
    if (!node) return false

    const downstream = tapestryData.downstream[nodeId] || []
    const nodeColor = stalenessColor(node.staleness)
    const mdOpts = this.getMarkdownOptions()
    const upstreamTags = node.dependsOn
      .map((dep) => {
        const depNode = tapestryData.nodes.find((entry) => entry.id === dep)
        return this.renderFiberTag(dep, depNode ? shortName(depNode.title) : dep.slice(0, 12))
      })
      .join('')
    const downstreamTags = downstream
      .map((entry) => `<span class="dep-tag downstream-tag" data-dep-id="${escapeHtml(entry.id)}">${statusIcon(entry.status)} ${escapeHtml(shortName(entry.title))}</span>`)
      .join('')

    let graphHtml = ''
    if (upstreamTags || downstreamTags) {
      const rows: string[] = []
      if (upstreamTags) rows.push(`<div class="dep-row"><span class="dep-dir-label">upstream</span>${upstreamTags}</div>`)
      if (downstreamTags) rows.push(`<div class="dep-row"><span class="dep-dir-label">downstream</span>${downstreamTags}</div>`)
      graphHtml = `<div class="tapestry-detail-graph">${rows.join('')}</div>`
    }

    const bodyHtml = node.body
      ? `<div class="tapestry-detail-body editable-markdown" data-node-id="${escapeHtml(node.id)}"></div>`
      : ''
    const outcomeHtml = node.outcome
      ? `<div class="tapestry-detail-outcome"><span class="outcome-label">Outcome</span> ${renderMarkdown(node.outcome, mdOpts)}</div>`
      : ''
    const tagsHtml = this.renderDetailTags(node.tags)
    const datesHtml = node.createdAt
      ? `<span class="detail-dates">Filed ${formatFiberDate(node.createdAt)}${node.closedAt ? ` · Closed ${formatFiberDate(node.closedAt)}` : ''}</span>`
      : ''
    const actionsHtml = this.options.isStaticMode()
      ? ''
      : `<span class="action detail-action-refresh" title="Re-fetch tapestry data">\u21BB</span>`
    const evidenceHtml = this.renderEvidence(node)
    const artifactGallery = node.evidence?.artifacts
      ? renderArtifactGallery(node.evidence.artifacts, (path) => this.options.getArtifactUrl(node.specName || '', path))
      : null
    const artifactsHtml = artifactGallery?.html || ''

    this.detailPanel.innerHTML = `
      <div class="tapestry-detail-resize"></div>
      <div class="tapestry-detail-header">
        <div class="tapestry-detail-title">
          <span class="staleness-badge" style="color: ${nodeColor}">${stalenessIcon(node.staleness)}</span>
          <span class="detail-name">${escapeHtml(node.title)}</span>
        </div>
        <button class="tapestry-detail-close">&times;</button>
      </div>
      <div class="tapestry-detail-meta">
        <span class="detail-status">${escapeHtml(node.status)}</span>
        <span class="kind-badge">${escapeHtml(node.kind)}</span>
        ${datesHtml}
        ${tagsHtml}
        <span class="detail-meta-spacer"></span>
        ${actionsHtml}
      </div>
      <div class="tapestry-detail-content">
        ${graphHtml}
        ${outcomeHtml}
        ${artifactsHtml}
        ${bodyHtml}
        ${evidenceHtml}
      </div>
    `

    this.showPanel()

    const bodyContainer = this.detailPanel.querySelector('.tapestry-detail-body')
    if (bodyContainer && node.body) {
      this.options.renderDetailBody(bodyContainer as HTMLElement, node.body)
    }

    this.bindNodeEvents(node)
    return true
  }

  renderFiber(fiberId: string): boolean {
    const tapestryData = this.options.getTapestryData()
    if (!tapestryData?.fibers) return false
    const fiber = tapestryData.fibers.find((entry) => entry.id === fiberId)
    if (!fiber) return false

    const mdOpts = this.getMarkdownOptions()
    const bodyHtml = fiber.body ? '<div class="tapestry-detail-body"></div>' : ''
    const upstreamTags = fiber.dependsOn
      .map((dep) => {
        const depFiber = tapestryData.fibers?.find((entry) => entry.id === dep)
        return this.renderFiberTag(dep, depFiber ? shortName(depFiber.title) : dep.slice(0, 12))
      })
      .join('')
    const graphHtml = upstreamTags
      ? `<div class="tapestry-detail-graph"><div class="dep-row"><span class="dep-dir-label">upstream</span>${upstreamTags}</div></div>`
      : ''
    const outcomeHtml = fiber.outcome
      ? `<div class="tapestry-detail-outcome"><span class="outcome-label">Outcome</span> ${renderMarkdown(fiber.outcome, mdOpts)}</div>`
      : ''
    const kindBadge = fiber.kind !== 'task' ? `<span class="kind-badge">${escapeHtml(fiber.kind)}</span>` : ''
    const tagsHtml = this.renderDetailTags(fiber.tags || [])

    this.detailPanel.innerHTML = `
      <div class="tapestry-detail-header">
        <div class="tapestry-detail-title">
          <span class="staleness-badge">${statusIcon(fiber.status)}</span>
          <span class="detail-name">${escapeHtml(fiber.title)}</span>
        </div>
        <button class="tapestry-detail-close">&times;</button>
      </div>
      <div class="tapestry-detail-meta">
        <span class="detail-status">${escapeHtml(fiber.status)}</span>
        ${kindBadge}
        ${tagsHtml}
      </div>
      <div class="tapestry-detail-content">
        ${graphHtml}
        ${outcomeHtml}
        ${bodyHtml}
      </div>
    `

    this.showPanel()

    const bodyContainer = this.detailPanel.querySelector('.tapestry-detail-body')
    if (bodyContainer && fiber.body) {
      this.options.renderDetailBody(bodyContainer as HTMLElement, fiber.body)
    }

    this.bindFiberEvents()
    return true
  }

  enterBodyEditMode(node: TapestryNode): void {
    const bodyEl = this.detailPanel.querySelector('.tapestry-detail-body')
    if (!bodyEl || this.options.isStaticMode()) return

    this.setMetaActions(
      `
      <span class="action primary detail-action-save">Save</span>
      <span class="action detail-action-discard">Discard</span>
    `,
      {
        '.detail-action-save': () => {
          void this.options.saveBodyAndExit(node)
        },
        '.detail-action-discard': () => this.options.exitBodyEditMode(node),
      },
    )

    this.options.enterBodyEditMode(node)
  }

  exitBodyEditMode(node: TapestryNode): void {
    this.setMetaActions(
      `<span class="action detail-action-refresh" title="Re-fetch tapestry data">\u21BB</span>`,
      {
        '.detail-action-refresh': () => {
          void this.options.refreshCurrentNode()
        },
      },
    )

    const bodyEl = this.detailPanel.querySelector('.tapestry-detail-body')
    if (bodyEl) {
      this.options.renderDetailBody(bodyEl as HTMLElement, node.body)
    }
  }

  private cleanupBindings(): void {
    if (this.galleryDetach) {
      this.galleryDetach()
      this.galleryDetach = null
    }
    if (this.artifactClickHandler) {
      this.detailPanel.removeEventListener('click', this.artifactClickHandler)
      this.artifactClickHandler = null
    }
  }

  private showPanel(): void {
    this.cleanupBindings()
    this.fiberListEl.classList.add('hidden')
    this.detailPanel.classList.remove('hidden')
    this.panel.querySelector('.tapestry-sidebar')?.classList.add('expanded')
  }

  private bindNodeEvents(node: TapestryNode): void {
    this.detailPanel.querySelector('.tapestry-detail-close')?.addEventListener('click', () => {
      this.options.hideDetail()
    })
    this.detailPanel.querySelector('.detail-action-refresh')?.addEventListener('click', () => {
      void this.options.refreshCurrentNode()
    })
    this.bindResizeHandle()
    this.bindCollapsibleSections()

    if (node.evidence?.artifacts && Object.keys(node.evidence.artifacts).length > 0) {
      const gallery = renderArtifactGallery(node.evidence.artifacts, (path) => this.options.getArtifactUrl(node.specName || '', path))
      gallery.attach(this.detailPanel)
      this.galleryDetach = gallery.detach
    }

    this.artifactClickHandler = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      const media = target.closest('.tapestry-artifact img, .tapestry-artifact iframe, .tapestry-artifact .artifact-open-overlay') as HTMLElement | null
      if (!media) return
      event.preventDefault()
      event.stopPropagation()
      this.options.openArtifactLightbox(media, node)
    }
    this.detailPanel.addEventListener('click', this.artifactClickHandler)

    this.bindDependencyLinks()
    this.bindContentLinks()

    const bodyEl = this.detailPanel.querySelector('.tapestry-detail-body')
    if (bodyEl) {
      bodyEl.addEventListener('dblclick', (event) => {
        if ((event.target as HTMLElement).closest('a, pre, code')) return
        if (this.options.isStaticMode()) return
        this.enterBodyEditMode(node)
      })
    }
  }

  private bindFiberEvents(): void {
    this.cleanupBindings()
    this.detailPanel.querySelector('.tapestry-detail-close')?.addEventListener('click', () => {
      this.options.hideDetail()
    })
    this.detailPanel.querySelectorAll('.dep-tag').forEach((tag) => {
      tag.addEventListener('click', () => {
        const depId = (tag as HTMLElement).dataset.depId
        if (depId) this.options.navigateToFiber(depId)
      })
    })
  }

  private bindResizeHandle(): void {
    const resizeHandle = this.detailPanel.querySelector('.tapestry-detail-resize')
    if (!resizeHandle) return
    resizeHandle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const startX = (event as MouseEvent).clientX
      const startWidth = this.detailWidth
      const onMove = (moveEvent: MouseEvent) => {
        const newWidth = Math.max(DETAIL_MIN_WIDTH, Math.min(DETAIL_MAX_WIDTH, startWidth - (moveEvent.clientX - startX)))
        this.detailWidth = newWidth
        this.detailPanel.style.width = `${newWidth}px`
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  }

  private bindCollapsibleSections(): void {
    this.detailPanel.querySelectorAll('.tapestry-collapsible').forEach((heading) => {
      heading.addEventListener('click', () => {
        const target = heading.getAttribute('data-target')
        if (!target) return
        const container = this.detailPanel.querySelector(`.${target}`)
        const icon = heading.querySelector('.toggle-icon')
        if (container && icon) {
          const isCollapsed = container.classList.toggle('collapsed')
          icon.textContent = isCollapsed ? '\u25B8' : '\u25BE'
        }
      })
    })
  }

  private bindDependencyLinks(): void {
    this.detailPanel.querySelectorAll('.dep-tag').forEach((tag) => {
      tag.addEventListener('click', () => {
        const depId = (tag as HTMLElement).dataset.depId
        if (depId) this.options.navigateToFiber(depId)
      })
    })
  }

  private bindContentLinks(): void {
    const contentEl = this.detailPanel.querySelector('.tapestry-detail-content')
    if (!contentEl) return
    contentEl.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest('a')
      if (!link) return
      event.preventDefault()
      const href = link.getAttribute('href') || ''
      if (/^https?:\/\//.test(href)) {
        window.open(href, '_blank', 'noopener')
        return
      }
      const fiberId = this.extractFiberId(href)
      if (fiberId) {
        this.options.navigateToFiber(fiberId)
        return
      }
      if (this.options.isStaticMode()) {
        this.options.openStaticFile(href)
        return
      }
      this.options.openFileFromLink(href)
    })
  }

  private renderFiberTag(id: string, label: string): string {
    return `<span class="dep-tag" data-dep-id="${escapeHtml(id)}">${escapeHtml(label)}</span>`
  }

  private renderEvidence(node: TapestryNode): string {
    if (!node.evidence?.metrics || Object.keys(node.evidence.metrics).length === 0) return ''

    const items: Array<{ key: string; value: string }> = []
    for (const [key, value] of Object.entries(node.evidence.metrics)) {
      if (typeof value === 'object' && value !== null) {
        for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
          items.push({
            key: `${key}.${childKey}`,
            value: typeof childValue === 'number' ? childValue.toFixed(4) : String(childValue),
          })
        }
        continue
      }
      items.push({
        key,
        value: typeof value === 'number' ? value.toFixed(4) : String(value),
      })
    }

    const itemsHtml = items
      .map(({ key, value }) => `<div class="evidence-item"><span class="evidence-key">${escapeHtml(key)}</span><span class="evidence-value">${escapeHtml(value)}</span></div>`)
      .join('')

    return `
      <div class="tapestry-evidence-section">
        <div class="tapestry-evidence">${itemsHtml}</div>
      </div>
    `
  }

  private renderDetailTags(tags: string[]): string {
    const displayTags = tags.filter((tag) => !tag.startsWith('tapestry:'))
    if (displayTags.length === 0) return ''
    return `<div class="tapestry-detail-tags">${displayTags.map((tag) => `<span class="fiber-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
  }

  private getMarkdownOptions():
    | {
      basePath: string
      originId: string
    }
    | undefined {
    const city = this.options.getCurrentCity()
    if (!city) return undefined
    return { basePath: `${city.path}/.felt`, originId: city.originId }
  }

  private setMetaActions(html: string, handlers: Record<string, () => void>): void {
    const metaEl = this.detailPanel.querySelector('.tapestry-detail-meta')
    if (!metaEl) return
    const spacer = metaEl.querySelector('.detail-meta-spacer')
    if (!spacer) return

    while (spacer.nextElementSibling) spacer.nextElementSibling.remove()
    spacer.insertAdjacentHTML('afterend', html)

    for (const [selector, handler] of Object.entries(handlers)) {
      metaEl.querySelector(selector)?.addEventListener('click', handler)
    }
  }

  private extractFiberId(href: string): string | null {
    const feltMatch = href.match(/\.felt\/([^/]+)\.md$/)
    if (feltMatch) return feltMatch[1]
    if (/^[\w-]+-[0-9a-f]{8}$/.test(href)) return href
    return null
  }
}
