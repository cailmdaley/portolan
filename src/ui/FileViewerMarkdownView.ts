import { escapeHtml, renderMarkdown, interpolateConfig, STALENESS_COLORS, formatFiberDate, renderArtifactGallery, attachInlinePathListeners } from './utils'
import { type FileViewerAnnotations } from './FileViewerAnnotations'

const API_BASE = `http://${window.location.hostname}:4004`

type Frontmatter = Record<string, any>

interface MarkdownViewState {
  currentPath: string
  currentOriginId: string
  currentCityPath: string
  currentCityId: string
  isVisible: boolean
}

interface FileViewerMarkdownViewOptions {
  contentEl: HTMLElement
  modeLineEl: HTMLElement
  annotations: FileViewerAnnotations
  getState: () => MarkdownViewState
  onOpenPath: (path: string, originId: string, cityPath: string, cityId: string, line?: number) => void
  onEnterEditMode: () => void
}

export class FileViewerMarkdownView {
  private contentEl: HTMLElement
  private modeLineEl: HTMLElement
  private annotations: FileViewerAnnotations
  private getState: () => MarkdownViewState
  private onOpenPath: FileViewerMarkdownViewOptions['onOpenPath']
  private onEnterEditMode: () => void
  private active = false
  private renderedMarkdownRequestId = 0
  private renderedMarkdownAbortController: AbortController | null = null

  constructor(options: FileViewerMarkdownViewOptions) {
    this.contentEl = options.contentEl
    this.modeLineEl = options.modeLineEl
    this.annotations = options.annotations
    this.getState = options.getState
    this.onOpenPath = options.onOpenPath
    this.onEnterEditMode = options.onEnterEditMode
  }

  isActive(): boolean {
    return this.active
  }

  show(content: string): void {
    this.active = true
    this.contentEl.innerHTML = ''

    const state = this.getState()
    const dirPath = state.currentPath.replace(/\/[^/]+$/, '')
    const wrapper = document.createElement('div')
    wrapper.className = 'file-viewer-markdown editable-markdown'

    const mdOpts = {
      basePath: state.currentCityPath || dirPath,
      originId: state.currentOriginId,
    }

    const isFiber = /\.felt\/[^/]+\.md$/i.test(state.currentPath)
    const { frontmatter, body } = isFiber
      ? this.parseFrontmatter(content)
      : { frontmatter: null, body: content }

    wrapper.innerHTML = frontmatter
      ? this.renderFiberHeader(frontmatter) + renderMarkdown(body, mdOpts)
      : renderMarkdown(content, mdOpts)

    this.contentEl.appendChild(wrapper)

    if ((window as any).Prism) {
      (window as any).Prism.highlightAllUnder(wrapper)
    }

    attachInlinePathListeners(wrapper, (relPath, line) => {
      const fullPath = relPath.startsWith('/') ? relPath : `${state.currentCityPath || dirPath}/${relPath}`
      this.onOpenPath(fullPath, state.currentOriginId, state.currentCityPath, state.currentCityId, line)
    })

    void this.loadContext(wrapper, state.currentPath, state.currentCityId)

    this.modeLineEl.textContent = 'Double-click to edit'

    let dblClickPending = false
    wrapper.addEventListener('dblclick', (e) => {
      dblClickPending = true
      if ((e.target as HTMLElement).closest('a')) return
      this.active = false
      this.onEnterEditMode()
    })

    wrapper.addEventListener('mouseup', () => {
      setTimeout(() => {
        if (dblClickPending) {
          dblClickPending = false
          return
        }
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          this.annotations.hideSelectionToolbar()
          return
        }
        this.annotations.handleRenderedSelection(sel)
      }, 200)
    })
  }

  reset(): void {
    this.active = false
    this.cancel()
  }

  cancel(): void {
    this.renderedMarkdownAbortController?.abort()
    this.renderedMarkdownAbortController = null
    this.renderedMarkdownRequestId += 1
  }

  getRuntimeStats(): {
    renderedMarkdownRequestId: number
    hasRenderedMarkdownRequest: boolean
  } {
    return {
      renderedMarkdownRequestId: this.renderedMarkdownRequestId,
      hasRenderedMarkdownRequest: this.renderedMarkdownAbortController !== null,
    }
  }

  private beginRequest(): { requestId: number; signal: AbortSignal } {
    this.renderedMarkdownAbortController?.abort()
    const controller = new AbortController()
    this.renderedMarkdownAbortController = controller
    this.renderedMarkdownRequestId += 1
    return { requestId: this.renderedMarkdownRequestId, signal: controller.signal }
  }

  private isRequestActive(requestId: number, wrapper: HTMLElement, filePath: string): boolean {
    const state = this.getState()
    return (
      this.renderedMarkdownRequestId === requestId &&
      state.isVisible &&
      state.currentPath === filePath &&
      this.contentEl.contains(wrapper)
    )
  }

  private finishRequest(requestId: number): void {
    if (this.renderedMarkdownRequestId === requestId) {
      this.renderedMarkdownAbortController = null
    }
  }

  private async loadContext(wrapper: HTMLElement, filePath: string, cityId: string): Promise<void> {
    const isFiber = /\.felt\/[^/]+\.md$/i.test(filePath)
    if (!isFiber || !cityId) return

    const { requestId, signal } = this.beginRequest()
    try {
      const response = await fetch(`${API_BASE}/tapestry?cityId=${encodeURIComponent(cityId)}`, { signal })
      if (!response.ok) return

      const data = await response.json()
      if (!data || !this.isRequestActive(requestId, wrapper, filePath)) return

      if (data.config) {
        interpolateConfig(wrapper, data.config)
      }

      const fiberId = filePath.match(/\.felt\/([^/]+)\.md$/i)?.[1]
      if (!fiberId) return

      const node = (data.nodes || []).find((entry: { id: string }) => entry.id === fiberId)

      if (node?.staleness) {
        const statusEl = wrapper.querySelector('.fiber-card-status') as HTMLElement | null
        if (statusEl) statusEl.style.color = STALENESS_COLORS[node.staleness] || ''
      }

      const downstream = data.downstream?.[fiberId] || []
      if (downstream.length > 0) {
        const console = wrapper.querySelector('.fiber-card-console')
        if (console) {
          const downstreamHtml = `<div class="fiber-card-downstream">
                <span class="fiber-card-deps-label">downstream</span>
                ${downstream.map((dep: { id: string; title: string; status: string }) => {
                  const icon = dep.status === 'closed' ? '●' : dep.status === 'active' ? '◐' : '○'
                  const short = dep.title.replace(/-[a-f0-9]{8}$/, '').replace(/[-_]/g, ' ').split(' ').slice(0, 3).join(' ')
                  return `<span class="fiber-card-dep">${icon} ${escapeHtml(short)}</span>`
                }).join(', ')}
              </div>`
          console.insertAdjacentHTML('afterend', downstreamHtml)
        }
      }

      if (node?.evidence?.artifacts && Object.keys(node.evidence.artifacts).length > 0) {
        const rule = wrapper.querySelector('.fiber-card-rule')
        if (rule) {
          const gallery = renderArtifactGallery(
            node.evidence.artifacts,
            (path: string) => `${API_BASE}/file-content?path=${encodeURIComponent(path)}&raw=true`,
          )
          rule.insertAdjacentHTML('afterend', gallery.html)
          gallery.attach(wrapper)
        }
      }

      if (node?.evidence?.metrics && Object.keys(node.evidence.metrics).length > 0) {
        const rule = wrapper.querySelector('.fiber-card-rule')
        if (rule) {
          const items: Array<{ key: string; value: string }> = []
          for (const [key, value] of Object.entries(node.evidence.metrics as Record<string, unknown>)) {
            if (typeof value === 'object' && value !== null) {
              for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
                items.push({
                  key: `${key}.${nestedKey}`,
                  value: typeof nestedValue === 'number' ? nestedValue.toFixed(4) : String(nestedValue),
                })
              }
            } else {
              items.push({
                key,
                value: typeof value === 'number' ? value.toFixed(4) : String(value),
              })
            }
          }
          const metricsHtml = `<div class="tapestry-evidence-section">
                <div class="tapestry-evidence">${items.map(({ key, value }) =>
                  `<div class="evidence-item"><span class="evidence-key">${escapeHtml(key)}</span><span class="evidence-value">${escapeHtml(value)}</span></div>`
                ).join('')}</div>
              </div>`
          rule.insertAdjacentHTML('afterend', metricsHtml)
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return
      console.error('Failed to load rendered markdown context:', error)
    } finally {
      this.finishRequest(requestId)
    }
  }

  private parseFrontmatter(content: string): { frontmatter: Frontmatter | null; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!match) return { frontmatter: null, body: content }

    const raw = match[1]
    const body = match[2]
    const frontmatter: Frontmatter = {}

    let currentKey = ''
    let inArray = false
    for (const line of raw.split('\n')) {
      const arrayItem = line.match(/^\s+-\s+(.+)$/)
      if (arrayItem && inArray && currentKey) {
        if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = []
        const value = arrayItem[1].trim()
        if (value.startsWith('{') || value.match(/^\w+:/)) {
          const idMatch = value.match(/(?:id:\s*['"]?)([^'"}\s]+)/)
          frontmatter[currentKey].push(idMatch ? { id: idMatch[1] } : value)
        } else {
          frontmatter[currentKey].push(value.replace(/^['"]|['"]$/g, ''))
        }
        continue
      }

      const kvMatch = line.match(/^(\S[\w-]+):\s*(.*)$/)
      if (kvMatch) {
        currentKey = kvMatch[1]
        const value = kvMatch[2].trim()
        if (value === '' || value === '|') {
          inArray = !value
          frontmatter[currentKey] = value === '|' ? '' : undefined
        } else {
          inArray = false
          frontmatter[currentKey] = value.replace(/^['"]|['"]$/g, '')
        }
      } else if (currentKey && frontmatter[currentKey] === '' && line.startsWith('  ')) {
        frontmatter[currentKey] += (frontmatter[currentKey] ? '\n' : '') + line.trim()
      }
    }

    return { frontmatter, body }
  }

  private renderFiberHeader(frontmatter: Frontmatter): string {
    const statusIcons: Record<string, string> = {
      untracked: '·',
      open: '○',
      active: '◐',
      closed: '●',
    }
    const kindLabels: Record<string, string> = {
      task: 'Task',
      decision: 'Decision',
      spec: 'Specification',
      doc: 'Document',
      question: 'Question',
      bug: 'Bug',
    }

    const status = frontmatter.status || 'open'
    const kind = frontmatter.kind || ''
    const title = frontmatter.title || 'Untitled'
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : []
    const deps = Array.isArray(frontmatter['depends-on']) ? frontmatter['depends-on'] : []
    const createdAt = frontmatter['created-at']
    const closedAt = frontmatter['closed-at']
    const closeReason = frontmatter['close-reason'] || frontmatter.outcome || ''

    const displayTags = tags.filter((tag: string) => !tag.startsWith('tapestry:'))
    const tagsHtml = displayTags.length > 0
      ? `<div class="fiber-card-tags">${displayTags.map((tag: string) =>
          `<span class="fiber-card-tag">${escapeHtml(tag.replace(/^\[|\]$/g, ''))}</span>`
        ).join('')}</div>`
      : ''

    const depsHtml = deps.length > 0
      ? `<div class="fiber-card-deps">
          <span class="fiber-card-deps-label">depends on</span>
          ${deps.map((dep: any) => {
            const id = typeof dep === 'string' ? dep : dep.id
            const short = id.replace(/-[a-f0-9]{8}$/, '')
            return `<a href=".felt/${escapeHtml(id)}.md" class="fiber-card-dep md-link">${escapeHtml(short)}</a>`
          }).join('<span class="fiber-card-deps-sep">,</span> ')}
        </div>`
      : ''

    const datesHtml = createdAt
      ? `<div class="fiber-card-dates">
          <span>Filed ${formatFiberDate(createdAt)}</span>
          ${closedAt ? `<span class="fiber-card-date-sep">·</span><span>Closed ${formatFiberDate(closedAt)}</span>` : ''}
        </div>`
      : ''

    const outcomeHtml = closeReason
      ? `<div class="fiber-card-outcome">
          <div class="fiber-card-outcome-label">Outcome</div>
          <div class="fiber-card-outcome-text">${renderMarkdown(closeReason)}</div>
        </div>`
      : ''

    const parts: string[] = []
    parts.push(`<span class="fiber-card-status fiber-status-${status}">${statusIcons[status] || '○'} ${escapeHtml(status)}</span>`)
    if (kind) parts.push(`<span class="fiber-card-kind">${escapeHtml(kindLabels[kind] || kind)}</span>`)
    if (deps.length > 0) parts.push(depsHtml)
    if (datesHtml) parts.push(datesHtml)
    if (tags.length > 0) parts.push(tagsHtml)

    return `
      <header class="fiber-card">
        <div class="fiber-card-title">${escapeHtml(title)}</div>
        <div class="fiber-card-console">${parts.join('<span class="fc-sep">·</span>')}</div>
        ${outcomeHtml}
        <div class="fiber-card-rule"></div>
      </header>
    `
  }
}
