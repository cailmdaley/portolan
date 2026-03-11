import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { AnnotationPanel } from './AnnotationPanel'
import {
  fileAnnotationsAsFiber,
  loadAnnotations,
  saveImageAnnotation as persistImageAnnotation,
  saveTextAnnotation,
  sendAnnotationsToWorker as persistAnnotationsToWorker,
} from './FileViewerAnnotationActions'
import type { Annotation } from './FileViewerAnnotationTypes'
import { type WorkerInfo, showWorkerPicker } from './WorkerPicker'
import { FileViewerImageAnnotations } from './FileViewerImageAnnotations'
import { escapeHtml, showToast } from './utils'

export const setFileViewerAnnotationsEffect = StateEffect.define<Annotation[]>()

const annotationMark = Decoration.mark({ class: 'cm-annotation-highlight' })

export const fileViewerAnnotationHighlightField: Extension = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setFileViewerAnnotationsEffect)) continue
      const marks: { from: number; to: number }[] = []
      for (const ann of effect.value) {
        const from = Math.max(0, Math.min(ann.from, tr.state.doc.length))
        const to = Math.max(from, Math.min(ann.to, tr.state.doc.length))
        if (from < to) {
          marks.push({ from, to })
        }
      }
      marks.sort((a, b) => a.from - b.from)
      decorations = Decoration.set(marks.map(mark => annotationMark.range(mark.from, mark.to)))
    }
    return decorations
  },
  provide: field => EditorView.decorations.from(field),
})

interface FileViewerAnnotationState {
  currentPath: string
  currentOriginId: string
  currentCityPath: string
  sourceWorkerId: string | null
  originalContent: string
  editorView: EditorView | null
  isVisible: boolean
}

interface FileViewerAnnotationHost {
  modalEl: HTMLElement
  contentEl: HTMLElement
  sendBtn: HTMLElement
  fiberBtn: HTMLElement
  getState: () => FileViewerAnnotationState
  scheduleDeferredUiTask: (task: () => void, delayMs: number) => number
}

export class FileViewerAnnotations {
  private panelEl: HTMLElement
  private host: FileViewerAnnotationHost
  private annotationPanel: AnnotationPanel<Annotation>
  private imageAnnotations: FileViewerImageAnnotations
  private annotations: Annotation[] = []
  private globalComment = ''
  private cityWorkers: WorkerInfo[] = []
  private onGetWorkers: ((originId: string, path: string) => Promise<WorkerInfo[]>) | null = null
  private selectionToolbar: HTMLElement | null = null

  constructor(panelEl: HTMLElement, host: FileViewerAnnotationHost) {
    this.panelEl = panelEl
    this.host = host

    this.annotationPanel = new AnnotationPanel<Annotation>(panelEl, {
      cssPrefix: 'file-viewer',
      emptyMessage: 'No annotations yet. Select text to add one.',
      renderPreview: (ann, index) => this.renderPreview(ann, index),
      onGoto: (ann) => this.gotoAnnotation(ann),
      onRefresh: async () => {
        await this.reloadAnnotations()
      },
      buildLoadQuery: () => {
        const { currentPath, currentOriginId } = this.host.getState()
        if (!currentPath) return ''
        return `path=${encodeURIComponent(currentPath)}&originId=${encodeURIComponent(currentOriginId)}`
      },
      getWorkers: () => this.cityWorkers,
      onSendToWorker: (annotations, workerId, createNew) =>
        this.sendAnnotationsToWorker(annotations, workerId, createNew),
      globalCommentPlaceholder: 'Add summary or overall context...',
      globalCommentLabel: 'Overall feedback:',
      hideFooter: true,
    })

    this.imageAnnotations = new FileViewerImageAnnotations({
      panelEl,
      scheduleDeferredUiTask: host.scheduleDeferredUiTask,
      getAnnotations: () => this.annotations,
      saveImageAnnotation: (x, y, comment) => this.saveImageAnnotation(x, y, comment),
    })

    this.setupEventListeners()
  }

  setOnGetWorkers(fn: (originId: string, path: string) => Promise<WorkerInfo[]>): void {
    this.onGetWorkers = fn
  }

  reset(): void {
    this.annotations = []
    this.globalComment = ''
    this.cityWorkers = []
    this.annotationPanel.reset()
    this.hideSelectionToolbar()
    this.imageAnnotations.reset()
    this.updateActionButtons()
  }

  setAnnotations(annotations: Annotation[]): void {
    this.annotations = [...annotations]
    this.annotationPanel.setAnnotations(this.annotations)
    this.updateAnnotationHighlights()
    this.updateActionButtons()
  }

  getAnnotations(): Annotation[] {
    return this.annotations
  }

  getGlobalComment(): string {
    return this.globalComment
  }

  getRuntimeStats(): {
    annotationCount: number
    hasImageAnnotationOutsideClickHandler: boolean
    hasImageAnnotationOutsideClickTimer: boolean
  } {
    const imageStats = this.imageAnnotations.getRuntimeStats()
    return {
      annotationCount: this.annotations.length,
      hasImageAnnotationOutsideClickHandler: imageStats.hasOutsideClickHandler,
      hasImageAnnotationOutsideClickTimer: imageStats.hasOutsideClickTimer,
    }
  }

  hasSelectionToolbar(): boolean {
    return this.selectionToolbar !== null
  }

  handleEditorSelection(state: EditorState): void {
    const selection = state.selection.main
    if (selection.empty) {
      this.hideSelectionToolbar()
      return
    }

    const selectedText = state.doc.sliceString(selection.from, selection.to)
    if (selectedText.trim().length === 0) {
      this.hideSelectionToolbar()
      return
    }

    const editorView = this.host.getState().editorView
    if (!editorView) return
    const coords = editorView.coordsAtPos(selection.from)
    if (!coords) return

    this.showSelectionToolbar({
      from: selection.from,
      to: selection.to,
      selectedText,
      left: coords.left,
      top: coords.top,
    })
  }

  handleRenderedSelection(sel: Selection): void {
    const selectedText = sel.toString().trim()
    const { originalContent } = this.host.getState()
    if (!selectedText || !originalContent) return

    const exactIndex = originalContent.indexOf(selectedText)
    if (exactIndex !== -1) {
      this.showSelectionToolbarForRange(sel, exactIndex, exactIndex + selectedText.length, selectedText)
      return
    }

    const normalize = (value: string) => value.replace(/\s+/g, '\x00')
    const normalizedSelected = normalize(selectedText)
    const normalizedOriginal = normalize(originalContent)
    const fuzzyIndex = normalizedOriginal.indexOf(normalizedSelected)
    if (fuzzyIndex === -1) {
      this.showSelectionToolbarForRange(sel, 0, 0, selectedText)
      return
    }

    let rawFrom = 0
    let consumed = 0
    while (consumed < fuzzyIndex && rawFrom < originalContent.length) {
      if (/\s/.test(originalContent[rawFrom]) && normalizedOriginal[consumed] === '\x00') {
        while (rawFrom < originalContent.length && /\s/.test(originalContent[rawFrom])) rawFrom += 1
        consumed += 1
        continue
      }
      rawFrom += 1
      consumed += 1
    }

    const from = rawFrom
    let matchConsumed = 0
    while (matchConsumed < normalizedSelected.length && rawFrom < originalContent.length) {
      if (/\s/.test(originalContent[rawFrom]) && normalizedSelected[matchConsumed] === '\x00') {
        while (rawFrom < originalContent.length && /\s/.test(originalContent[rawFrom])) rawFrom += 1
        matchConsumed += 1
        continue
      }
      rawFrom += 1
      matchConsumed += 1
    }

    this.showSelectionToolbarForRange(sel, from, rawFrom, selectedText)
  }

  setupImageAnnotation(container: HTMLElement, img: HTMLImageElement): void {
    this.imageAnnotations.setupImageAnnotation(container, img)
  }

  renderImageAnnotationMarkers(container: HTMLElement): void {
    this.imageAnnotations.renderMarkers(container)
  }

  async showWorkerPicker(): Promise<void> {
    const { currentPath, currentOriginId, sourceWorkerId } = this.host.getState()
    if (!currentPath || !this.hasContent()) return

    if (sourceWorkerId) {
      await this.sendAnnotationsToWorker(this.annotations, sourceWorkerId)
      return
    }

    if (this.onGetWorkers) {
      try {
        this.cityWorkers = await this.onGetWorkers(currentOriginId, currentPath)
      } catch (error) {
        console.error('Failed to get workers:', error)
        this.cityWorkers = []
      }
    }

    showWorkerPicker(this.cityWorkers, this.annotations.length, {
      onSelectWorker: (workerId) => this.sendAnnotationsToWorker(this.annotations, workerId),
      onNewWorker: () => this.sendAnnotationsToWorker(this.annotations, undefined, true),
    })
  }

  async fileAsFiber(): Promise<void> {
    const { currentPath, currentOriginId, currentCityPath } = this.host.getState()
    if (!currentPath || !this.hasContent()) return

    try {
      this.host.fiberBtn.textContent = 'Filing...'
      this.host.fiberBtn.setAttribute('disabled', 'true')

      const result = await fileAnnotationsAsFiber({
        currentPath,
        currentOriginId,
        currentCityPath,
        annotations: this.annotations,
        globalComment: this.globalComment,
      })
      this.globalComment = ''
      this.annotationPanel.resetGlobalInput()
      this.updateActionButtons()

      this.host.fiberBtn.textContent = 'Filed!'
      this.host.fiberBtn.removeAttribute('disabled')
      this.host.scheduleDeferredUiTask(() => {
        if (!this.host.getState().isVisible) return
        this.host.fiberBtn.textContent = 'File as Fiber'
      }, 2000)
      showToast(`Filed as fiber: ${result.fiberId}`, 'success', 4000)
    } catch (error: any) {
      console.error('Failed to file as fiber:', error)
      this.host.fiberBtn.textContent = 'File as Fiber'
      this.host.fiberBtn.removeAttribute('disabled')
      alert(`Failed to file as fiber: ${error.message}`)
    }
  }

  hideSelectionToolbar(): void {
    if (!this.selectionToolbar) return
    this.selectionToolbar.remove()
    this.selectionToolbar = null
  }

  updateAnnotationHighlights(): void {
    const editorView = this.host.getState().editorView
    if (!editorView) return
    editorView.dispatch({
      effects: setFileViewerAnnotationsEffect.of(this.annotations),
    })
  }

  dispose(): void {
    this.hideSelectionToolbar()
    this.imageAnnotations.dispose()
  }

  private setupEventListeners(): void {
    const globalCommentTextarea = this.panelEl.querySelector('.ann-panel-global-input textarea') as HTMLTextAreaElement | null
    globalCommentTextarea?.addEventListener('input', () => {
      this.globalComment = globalCommentTextarea.value
      this.updateActionButtons()
    })

    this.host.sendBtn.addEventListener('click', () => {
      void this.showWorkerPicker()
    })
    this.host.fiberBtn.addEventListener('click', () => {
      void this.fileAsFiber()
    })
  }

  private renderPreview(ann: Annotation, index: number): string {
    if (ann.isImageAnnotation) {
      return `<span class="annotation-line">#${index + 1}</span> <em style="color: var(--text-muted);">[Image point]</em>`
    }

    let locationInfo = ''
    if (ann.line) {
      const lineRange = ann.endLine && ann.endLine !== ann.line
        ? `L${ann.line}-${ann.endLine}`
        : `L${ann.line}`
      locationInfo = `<span class="annotation-line">${lineRange}</span> `
    }
    const truncated = ann.originalText.length > 50
      ? ann.originalText.slice(0, 50) + '...'
      : ann.originalText
    return `${locationInfo}"${escapeHtml(truncated)}"`
  }

  private hasContent(): boolean {
    return this.annotations.length > 0 || this.globalComment.trim().length > 0
  }

  private updateActionButtons(): void {
    const visible = this.hasContent() ? 'inline-block' : 'none'
    this.host.sendBtn.style.display = visible
    this.host.fiberBtn.style.display = visible
  }

  private showSelectionToolbarForRange(sel: Selection, from: number, to: number, selectedText: string): void {
    const range = sel.getRangeAt(0)
    this.showSelectionToolbar({
      from,
      to,
      selectedText,
      left: range.getBoundingClientRect().left,
      top: range.getBoundingClientRect().top,
    })
  }

  private showSelectionToolbar(args: {
    from: number
    to: number
    selectedText: string
    left: number
    top: number
  }): void {
    this.hideSelectionToolbar()

    const toolbar = document.createElement('div')
    toolbar.className = 'selection-toolbar'
    toolbar.innerHTML = `
      <button class="selection-toolbar-btn" data-action="comment" title="Add comment">
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
        </svg>
        Comment
      </button>
      <button class="selection-toolbar-btn" data-action="delete" title="Mark for deletion">
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 12h12" />
        </svg>
        Delete
      </button>
      <button class="selection-toolbar-btn selection-toolbar-close" title="Cancel">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    `

    const modalRect = this.host.modalEl.getBoundingClientRect()
    toolbar.style.position = 'absolute'
    toolbar.style.left = `${args.left - modalRect.left}px`
    toolbar.style.top = `${args.top - modalRect.top - 40}px`

    toolbar.querySelector('[data-action="comment"]')?.addEventListener('click', () => {
      this.startAnnotationInput(args.from, args.to, args.selectedText)
    })
    toolbar.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      void this.saveAnnotation(args.from, args.to, args.selectedText, '[DELETE]')
      this.hideSelectionToolbar()
    })
    toolbar.querySelector('.selection-toolbar-close')?.addEventListener('click', () => {
      this.hideSelectionToolbar()
    })

    this.selectionToolbar = toolbar
    this.host.modalEl.appendChild(toolbar)
  }

  private startAnnotationInput(from: number, to: number, selectedText: string): void {
    if (!this.selectionToolbar) return

    this.selectionToolbar.innerHTML = `
      <textarea class="annotation-input" placeholder="Add a comment..." rows="2"></textarea>
      <div class="annotation-input-actions">
        <button class="annotation-save-btn">Save</button>
        <button class="annotation-cancel-btn">Cancel</button>
      </div>
    `

    const textarea = this.selectionToolbar.querySelector('.annotation-input') as HTMLTextAreaElement | null
    const saveBtn = this.selectionToolbar.querySelector('.annotation-save-btn')
    const cancelBtn = this.selectionToolbar.querySelector('.annotation-cancel-btn')

    window.setTimeout(() => textarea?.focus(), 0)

    const save = async () => {
      const comment = textarea?.value.trim() || ''
      if (!comment) return
      await this.saveAnnotation(from, to, selectedText, comment)
      this.hideSelectionToolbar()
    }

    saveBtn?.addEventListener('click', () => {
      void save()
    })
    cancelBtn?.addEventListener('click', () => this.hideSelectionToolbar())
    textarea?.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void save()
      } else if (event.key === 'Escape') {
        this.hideSelectionToolbar()
      }
    })
  }

  private async saveAnnotation(from: number, to: number, selectedText: string, comment: string): Promise<void> {
    const { currentPath, currentOriginId, editorView, originalContent, isVisible } = this.host.getState()
    if (!currentPath) return

    const content = editorView?.state.doc.toString() || originalContent
    const contextBefore = content.slice(Math.max(0, from - 20), from)
    const contextAfter = content.slice(to, Math.min(content.length, to + 20))

    let line: number | undefined
    let endLine: number | undefined
    if (editorView) {
      line = editorView.state.doc.lineAt(from).number
      endLine = editorView.state.doc.lineAt(to).number
    } else {
      line = (content.slice(0, from).match(/\n/g) || []).length + 1
      endLine = (content.slice(0, to).match(/\n/g) || []).length + 1
    }

    try {
      const annotation = await saveTextAnnotation({
        currentPath,
        currentOriginId,
        from,
        to,
        line,
        endLine,
        selectedText,
        comment,
        contextBefore,
        contextAfter,
      })
      const state = this.host.getState()
      if (!isVisible || state.currentPath !== currentPath || state.currentOriginId !== currentOriginId) return
      this.annotations.push(annotation)
      this.annotationPanel.setAnnotations(this.annotations)
      this.updateAnnotationHighlights()
      this.updateActionButtons()
    } catch (error: any) {
      console.error('Failed to save annotation:', error)
      alert(`Failed to save annotation: ${error.message}`)
    }
  }

  private async saveImageAnnotation(x: number, y: number, comment: string): Promise<Annotation | null> {
    const { currentPath, currentOriginId } = this.host.getState()
    if (!currentPath) return null

    try {
      const annotation = await persistImageAnnotation({
        currentPath,
        currentOriginId,
        x,
        y,
        comment,
      })
      const state = this.host.getState()
      if (!state.isVisible || state.currentPath !== currentPath || state.currentOriginId !== currentOriginId) {
        return null
      }
      this.annotations.push(annotation)
      this.annotationPanel.setAnnotations(this.annotations)
      this.updateActionButtons()
      return annotation
    } catch (error: any) {
      console.error('Failed to save image annotation:', error)
      alert(`Failed to save annotation: ${error.message}`)
      return null
    }
  }

  private async reloadAnnotations(): Promise<void> {
    const { currentPath, currentOriginId, isVisible } = this.host.getState()
    if (!currentPath) return

    try {
      const annotations = await loadAnnotations(currentPath, currentOriginId)
      const state = this.host.getState()
      if (!isVisible || state.currentPath !== currentPath || state.currentOriginId !== currentOriginId) return
      this.setAnnotations(annotations)
    } catch {
      const state = this.host.getState()
      if (!state.isVisible || state.currentPath !== currentPath || state.currentOriginId !== currentOriginId) return
      this.setAnnotations([])
    }
  }

  private gotoAnnotation(annotation: Annotation): void {
    if (annotation.isImageAnnotation) {
      const marker = this.host.contentEl.querySelector(`.image-annotation-marker[title="${annotation.comment}"]`) as HTMLElement | null
      if (!marker) return
      marker.scrollIntoView({ behavior: 'smooth', block: 'center' })
      marker.style.transform = 'translate(-50%, -50%) scale(1.5)'
      this.host.scheduleDeferredUiTask(() => {
        marker.style.transform = 'translate(-50%, -50%) scale(1)'
      }, 300)
      return
    }

    const editorView = this.host.getState().editorView
    if (!editorView) return
    editorView.dispatch({
      selection: { anchor: annotation.from, head: annotation.to },
      scrollIntoView: true,
    })
  }

  private async sendAnnotationsToWorker(
    annotations: Annotation[],
    workerId?: string,
    createNew?: boolean,
  ): Promise<void> {
    const { currentPath, currentOriginId, isVisible } = this.host.getState()
    if (!currentPath || (annotations.length === 0 && this.globalComment.trim().length === 0)) return

    try {
      await persistAnnotationsToWorker({
        currentPath,
        currentOriginId,
        workerId,
        createNew,
        annotations,
        globalComment: this.globalComment,
      })

      this.globalComment = ''
      this.annotationPanel.resetGlobalInput()
      this.updateActionButtons()

      const originalText = createNew ? 'Send to Worker' : this.host.sendBtn.textContent
      this.host.sendBtn.textContent = 'Sent!'
      this.host.sendBtn.removeAttribute('disabled')
      this.host.scheduleDeferredUiTask(() => {
        if (!this.host.getState().isVisible || !isVisible) return
        this.host.sendBtn.textContent = originalText || 'Send to Worker'
      }, 2000)
    } catch (error: any) {
      console.error('Failed to send annotations:', error)
      this.host.sendBtn.textContent = 'Send to Worker'
      this.host.sendBtn.removeAttribute('disabled')
      alert(`Failed to send annotations: ${error.message}`)
    }
  }

}
