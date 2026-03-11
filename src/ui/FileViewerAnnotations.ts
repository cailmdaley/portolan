import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { AnnotationPanel } from './AnnotationPanel'
import {
  fileAnnotationsAsFiber,
  loadAnnotations,
  saveImageAnnotation as persistImageAnnotation,
  sendAnnotationsToWorker as persistAnnotationsToWorker,
} from './FileViewerAnnotationActions'
import type { Annotation } from './FileViewerAnnotationTypes'
import { type WorkerInfo, showWorkerPicker } from './WorkerPicker'
import { FileViewerImageAnnotations } from './FileViewerImageAnnotations'
import { FileViewerTextAnnotations } from './FileViewerTextAnnotations'
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
  private textAnnotations: FileViewerTextAnnotations
  private annotations: Annotation[] = []
  private globalComment = ''
  private cityWorkers: WorkerInfo[] = []
  private onGetWorkers: ((originId: string, path: string) => Promise<WorkerInfo[]>) | null = null

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
    this.textAnnotations = new FileViewerTextAnnotations({
      modalEl: host.modalEl,
      getState: () => {
        const state = host.getState()
        return {
          currentPath: state.currentPath,
          currentOriginId: state.currentOriginId,
          originalContent: state.originalContent,
          editorView: state.editorView,
          isVisible: state.isVisible,
        }
      },
      addAnnotation: (annotation) => this.addAnnotation(annotation, true),
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
    this.textAnnotations.reset()
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
    return this.textAnnotations.hasSelectionToolbar()
  }

  handleEditorSelection(state: EditorState): void {
    this.textAnnotations.handleEditorSelection(state)
  }

  handleRenderedSelection(sel: Selection): void {
    this.textAnnotations.handleRenderedSelection(sel)
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
    this.textAnnotations.hideSelectionToolbar()
  }

  updateAnnotationHighlights(): void {
    const editorView = this.host.getState().editorView
    if (!editorView) return
    editorView.dispatch({
      effects: setFileViewerAnnotationsEffect.of(this.annotations),
    })
  }

  dispose(): void {
    this.textAnnotations.dispose()
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

  private addAnnotation(annotation: Annotation, updateHighlights: boolean): void {
    this.annotations.push(annotation)
    this.annotationPanel.setAnnotations(this.annotations)
    if (updateHighlights) {
      this.updateAnnotationHighlights()
    }
    this.updateActionButtons()
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
      this.addAnnotation(annotation, false)
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
