import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { AnnotationPanel } from './AnnotationPanel'
import {
  loadAnnotations,
  saveImageAnnotation as persistImageAnnotation,
} from './FileViewerAnnotationActions'
import type { Annotation } from './FileViewerAnnotationTypes'
import type { WorkerInfo } from './WorkerPicker'
import { FileViewerAnnotationTransport } from './FileViewerAnnotationTransport'
import { FileViewerImageAnnotations } from './FileViewerImageAnnotations'
import { FileViewerTextAnnotations } from './FileViewerTextAnnotations'
import { escapeHtml } from './utils'

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
  private host: FileViewerAnnotationHost
  private annotationPanel: AnnotationPanel<Annotation>
  private transport: FileViewerAnnotationTransport
  private imageAnnotations: FileViewerImageAnnotations
  private textAnnotations: FileViewerTextAnnotations
  private annotations: Annotation[] = []

  constructor(panelEl: HTMLElement, host: FileViewerAnnotationHost) {
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
      getWorkers: () => [],
      onSendToWorker: async () => {},
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
    this.transport = new FileViewerAnnotationTransport({
      panelEl,
      sendBtn: host.sendBtn,
      fiberBtn: host.fiberBtn,
      annotationPanel: this.annotationPanel,
      getState: () => {
        const state = host.getState()
        return {
          currentPath: state.currentPath,
          currentOriginId: state.currentOriginId,
          currentCityPath: state.currentCityPath,
          sourceWorkerId: state.sourceWorkerId,
          isVisible: state.isVisible,
        }
      },
      getAnnotations: () => this.annotations,
      scheduleDeferredUiTask: host.scheduleDeferredUiTask,
    })
  }

  setOnGetWorkers(fn: (originId: string, path: string) => Promise<WorkerInfo[]>): void {
    this.transport.setOnGetWorkers(fn)
  }

  reset(): void {
    this.annotations = []
    this.annotationPanel.reset()
    this.transport.reset()
    this.textAnnotations.reset()
    this.imageAnnotations.reset()
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
    return this.annotationPanel.getGlobalComment()
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
    await this.transport.showWorkerPicker()
  }

  async fileAsFiber(): Promise<void> {
    await this.transport.fileAsFiber()
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

  private updateActionButtons(): void {
    this.transport.updateActionButtons()
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

}
