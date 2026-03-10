import type { City } from '../state/types'
import { AnnotationPanel } from './AnnotationPanel'
import type { ClaimsAnnotation, TapestryNode } from './tapestry-types'
import { escapeHtml, showToast } from './utils'
import type { WorkerInfo } from './WorkerPicker'

const API_BASE = `http://${window.location.hostname}:4004`
const PREVIEW_TRUNCATION = 80
const TEXT_SELECTION_TRUNCATION = 60
const POPOVER_WIDTH = 280
const POPOVER_HEIGHT = 160
const POPOVER_MARGIN = 8

interface AnnotationSaveInput {
  claimId: string
  selectedText?: string
  artifact?: string
  x?: number
  y?: number
  line?: number
  endLine?: number
  filePath?: string
  comment: string
  isImageAnnotation?: boolean
}

interface TapestryClaimsAnnotationsOptions {
  panelEl: HTMLElement
  getContainer: () => HTMLElement
  getCurrentCity: () => City | null
  getSelectedNodeId: () => string | null
  getSelectedNode: () => TapestryNode | null
  getDetailBodyElement: () => HTMLElement | null
  getWorkers: () => WorkerInfo[]
}

export class TapestryClaimsAnnotations {
  private panel: AnnotationPanel<ClaimsAnnotation>
  private options: TapestryClaimsAnnotationsOptions

  constructor(options: TapestryClaimsAnnotationsOptions) {
    this.options = options
    this.panel = new AnnotationPanel<ClaimsAnnotation>(options.panelEl, {
      cssPrefix: 'claims',
      emptyMessage: 'Select text or click an image to annotate',
      renderPreview: (annotation) => this.renderPreview(annotation),
      onPromote: (annotation) => this.promoteAnnotation(annotation),
      onRefresh: () => {
        const nodeId = this.options.getSelectedNodeId()
        if (nodeId) return this.load(nodeId)
      },
      buildLoadQuery: () => {
        const nodeId = this.options.getSelectedNodeId()
        return nodeId ? `claimId=${encodeURIComponent(nodeId)}` : ''
      },
      getWorkers: () => this.options.getWorkers(),
      onSendToWorker: (annotations, workerId, createNew) =>
        this.sendToWorker(annotations, workerId, createNew),
      onFileAsFiber: (annotations) => this.fileAsFiber(annotations),
      globalCommentPlaceholder: 'General feedback…',
    })
  }

  reset(): void {
    this.panel.reset()
  }

  hidePanel(): void {
    this.panel.hidePanel()
  }

  load(nodeId: string): Promise<void> {
    return this.loadAnnotations(nodeId)
  }

  handleTextSelection(selection: Selection): void {
    const text = selection.toString().trim()
    const nodeId = this.options.getSelectedNodeId()
    if (!text || !nodeId) return

    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const node = this.options.getSelectedNode()
    const location = this.estimateTextLocation(node, text, nodeId)

    this.showAnnotationPopover(
      rect.left + rect.width / 2,
      rect.bottom + 4,
      `“${text.slice(0, TEXT_SELECTION_TRUNCATION)}${text.length > TEXT_SELECTION_TRUNCATION ? '…' : ''}”`,
    ).then(comment => {
      if (!comment) return
      void this.saveAnnotation({
        claimId: nodeId,
        selectedText: text,
        comment,
        ...location,
      })
    })
  }

  promptImageAnnotation(node: TapestryNode, artifactName: string, x: number, y: number): void {
    this.showAnnotationPopover(
      window.innerWidth / 2,
      window.innerHeight / 2,
      `Pin on ${artifactName} (${Math.round(x)}%, ${Math.round(y)}%)`,
    ).then(comment => {
      if (!comment) return
      void this.saveAnnotation({
        claimId: node.id,
        artifact: artifactName,
        x,
        y,
        comment,
        isImageAnnotation: true,
      })
    })
  }

  private renderPreview(annotation: ClaimsAnnotation): string {
    if (annotation.selectedText) {
      const truncated = annotation.selectedText.slice(0, PREVIEW_TRUNCATION)
      const ellipsis = annotation.selectedText.length > PREVIEW_TRUNCATION ? '…' : ''
      return `<div class="ann-selected-text">“${escapeHtml(truncated)}${ellipsis}”</div>`
    }
    if (annotation.artifact) {
      return `<div class="ann-pin-label">📌 ${escapeHtml(annotation.artifact)} (${Math.round(annotation.x || 0)}%, ${Math.round(annotation.y || 0)}%)</div>`
    }
    return ''
  }

  private estimateTextLocation(
    node: TapestryNode | null,
    text: string,
    nodeId: string,
  ): { line?: number; endLine?: number; filePath?: string } {
    if (!node?.body) return {}
    const bodyEl = this.options.getDetailBodyElement()
    if (!bodyEl) return { filePath: `.felt/${nodeId}.md` }

    const fullText = bodyEl.textContent || ''
    const startOffset = fullText.indexOf(text)
    if (startOffset < 0) return { filePath: `.felt/${nodeId}.md` }

    const ratio = startOffset / (fullText.length || 1)
    const bodyLines = node.body.split('\n')
    const startLineIdx = Math.min(Math.floor(ratio * bodyLines.length), bodyLines.length - 1)
    const line = startLineIdx + 1
    const selectionLines = text.split('\n').length

    return {
      line,
      endLine: selectionLines > 1 ? line + selectionLines - 1 : undefined,
      filePath: `.felt/${nodeId}.md`,
    }
  }

  private showAnnotationPopover(
    anchorX: number,
    anchorY: number,
    preview: string,
  ): Promise<string | null> {
    return new Promise(resolve => {
      this.options.getContainer().querySelector('.tapestry-ann-popover')?.remove()

      const popover = document.createElement('div')
      popover.className = 'tapestry-ann-popover'

      const left = Math.max(
        POPOVER_MARGIN,
        Math.min(anchorX - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN),
      )
      let top = anchorY + POPOVER_MARGIN
      if (top + POPOVER_HEIGHT > window.innerHeight - POPOVER_MARGIN) {
        top = anchorY - POPOVER_HEIGHT - POPOVER_MARGIN
      }

      popover.style.left = `${left}px`
      popover.style.top = `${top}px`
      popover.innerHTML = `
        <div class="ann-popover-preview">${escapeHtml(preview)}</div>
        <textarea class="ann-popover-input" placeholder="Add comment…" rows="3"></textarea>
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
        const value = textarea.value.trim()
        close(value || null)
      })
      cancelBtn.addEventListener('click', () => close(null))
      textarea.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          const value = textarea.value.trim()
          close(value || null)
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          close(null)
        }
      })

      this.options.getContainer().appendChild(popover)
      textarea.focus()
    })
  }

  private async saveAnnotation(data: AnnotationSaveInput): Promise<void> {
    await this.postAnnotation(data.claimId, {
      comment: data.comment,
      selectedText: data.selectedText,
      artifact: data.artifact,
      x: data.x,
      y: data.y,
      line: data.line,
      endLine: data.endLine,
      filePath: data.filePath,
      isImageAnnotation: !!data.isImageAnnotation,
    }, 'Annotation saved')
  }

  private async loadAnnotations(nodeId: string): Promise<void> {
    const response = await this.fetchApi(`/annotations?claimId=${encodeURIComponent(nodeId)}`)
    if (!response) return

    const result = await response.json()
    const annotations: ClaimsAnnotation[] = result.annotations || []
    if (annotations.length > 0) {
      this.panel.expand()
    } else {
      this.panel.hidePanel()
    }
    this.panel.setAnnotations(annotations)
  }

  private async postAnnotation(
    claimId: string,
    fields: Record<string, unknown>,
    successMessage: string,
  ): Promise<boolean> {
    const currentCity = this.options.getCurrentCity()
    const response = await this.fetchApi('/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originId: currentCity?.originId || 'local',
        isClaimAnnotation: true,
        claimId,
        ...fields,
      }),
    })

    if (!response) return false

    showToast(successMessage, 'success', 2000)
    this.panel.expand()
    void this.load(claimId)
    return true
  }

  private async promoteAnnotation(annotation: ClaimsAnnotation): Promise<void> {
    const currentCity = this.options.getCurrentCity()
    if (!currentCity) return

    const response = await this.fetchApi('/promote-to-felt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimId: annotation.claimId,
        comment: annotation.comment,
        cityId: currentCity.id,
      }),
    })

    if (response) {
      showToast('Promoted to felt', 'success', 2000)
    }
  }

  private async sendToWorker(
    annotations: ClaimsAnnotation[],
    workerId?: string,
    createNew?: boolean,
  ): Promise<void> {
    const currentCity = this.options.getCurrentCity()
    if (!currentCity) return

    const response = await this.fetchApi('/send-annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId,
        createNewWorker: createNew,
        filePath: `${currentCity.path}/claims`,
        originId: currentCity.originId,
        annotations,
        globalComment: this.panel.getGlobalComment() || undefined,
        cityName: currentCity.name,
        isClaimsSend: true,
      }),
    })

    if (response) {
      showToast('Annotations sent to worker', 'success')
    }
  }

  private async fileAsFiber(annotations: ClaimsAnnotation[]): Promise<void> {
    const currentCity = this.options.getCurrentCity()
    const node = this.options.getSelectedNode()
    if (!currentCity || !node) return

    const globalComment = this.panel.getGlobalComment()
    const bodyLines: string[] = []
    if (globalComment) {
      bodyLines.push(globalComment, '')
    }

    if (annotations.length > 0) {
      bodyLines.push('## Annotations', '')
      annotations.forEach((annotation, index) => {
        const text = annotation.selectedText
          ? `"${annotation.selectedText.slice(0, 60).replace(/\n/g, ' ')}${annotation.selectedText.length > 60 ? '...' : ''}"`
          : annotation.artifact
            ? `[Image: ${annotation.artifact}]`
            : ''
        bodyLines.push(`${index + 1}. ${text}`)
        bodyLines.push(`   > ${annotation.comment}`)
        bodyLines.push('')
      })
    }

    const response = await this.fetchApi('/file-as-fiber', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: `${currentCity.path}/.felt/${node.id}.md`,
        originId: currentCity.originId,
        cityPath: currentCity.path,
        title: `Feedback on ${node.title}`,
        body: bodyLines.join('\n'),
        kind: 'task',
      }),
    })

    if (response) {
      const result = await response.json()
      this.panel.resetGlobalInput()
      showToast(`Filed as fiber: ${result.fiberId}`, 'success', 4000)
    }
  }

  private async fetchApi(path: string, init?: RequestInit): Promise<Response | null> {
    try {
      const response = await fetch(`${API_BASE}${path}`, init)
      if (!response.ok) {
        console.error(`API error ${path}:`, await response.text())
        showToast('Request failed', 'error')
        return null
      }
      return response
    } catch (error) {
      console.error(`API error ${path}:`, error)
      showToast('Request failed', 'error')
      return null
    }
  }
}
