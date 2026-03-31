import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import type { Annotation } from './FileViewerAnnotationTypes'
import { FileViewerAnnotationPanelController } from './FileViewerAnnotationPanelController'
import { FileViewerAnnotationTransport } from './FileViewerAnnotationTransport'
import { FileViewerImageAnnotations } from './FileViewerImageAnnotations'
import { FileViewerTextAnnotations } from './FileViewerTextAnnotations'
import type { WorkerInfo } from './WorkerPicker'

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
  onGotoSlide?: (slideIndex: number) => void
}

export class FileViewerAnnotations {
  private host: FileViewerAnnotationHost
  private panelController: FileViewerAnnotationPanelController
  private transport: FileViewerAnnotationTransport
  private imageAnnotations: FileViewerImageAnnotations
  private textAnnotations: FileViewerTextAnnotations

  constructor(panelEl: HTMLElement, host: FileViewerAnnotationHost) {
    this.host = host

    this.panelController = new FileViewerAnnotationPanelController({
      panelEl,
      contentEl: host.contentEl,
      getState: () => {
        const state = host.getState()
        return {
          currentPath: state.currentPath,
          currentOriginId: state.currentOriginId,
          isVisible: state.isVisible,
          editorView: state.editorView,
        }
      },
      scheduleDeferredUiTask: host.scheduleDeferredUiTask,
      onAnnotationsChanged: () => {
        this.updateAnnotationHighlights()
        this.transport.updateActionButtons()
      },
      onGotoSlide: host.onGotoSlide,
    })

    this.imageAnnotations = new FileViewerImageAnnotations({
      panelEl,
      scheduleDeferredUiTask: host.scheduleDeferredUiTask,
      getAnnotations: () => this.panelController.getAnnotations(),
      saveImageAnnotation: (x, y, comment) => this.panelController.saveImageAnnotation(x, y, comment),
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
      addAnnotation: (annotation) => this.panelController.addAnnotation(annotation),
    })
    this.transport = new FileViewerAnnotationTransport({
      panelEl,
      sendBtn: host.sendBtn,
      fiberBtn: host.fiberBtn,
      hasContent: () => this.panelController.hasContent(),
      getGlobalComment: () => this.panelController.getGlobalComment(),
      resetGlobalComment: () => this.panelController.resetGlobalComment(),
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
      getAnnotations: () => this.panelController.getAnnotations(),
      scheduleDeferredUiTask: host.scheduleDeferredUiTask,
    })
  }

  setOnGetWorkers(fn: (originId: string, path: string) => Promise<WorkerInfo[]>): void {
    this.transport.setOnGetWorkers(fn)
  }

  reset(): void {
    this.panelController.reset()
    this.transport.reset()
    this.textAnnotations.reset()
    this.imageAnnotations.reset()
  }

  setAnnotations(annotations: Annotation[]): void {
    this.panelController.setAnnotations(annotations)
  }

  getAnnotations(): Annotation[] {
    return this.panelController.getAnnotations()
  }

  getGlobalComment(): string {
    return this.panelController.getGlobalComment()
  }

  getRuntimeStats(): {
    annotationCount: number
    hasImageAnnotationOutsideClickHandler: boolean
    hasImageAnnotationOutsideClickTimer: boolean
  } {
    const imageStats = this.imageAnnotations.getRuntimeStats()
    return {
      annotationCount: this.panelController.getAnnotations().length,
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

  setCurrentSlide(slide: number | null, title?: string): void {
    this.panelController.setCurrentSlide(slide, title)
  }

  async saveSlideAnnotation(slide: number, comment: string): Promise<void> {
    await this.panelController.saveSlideAnnotation(slide, comment)
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
      effects: setFileViewerAnnotationsEffect.of(this.panelController.getAnnotations()),
    })
  }

  dispose(): void {
    this.textAnnotations.dispose()
    this.imageAnnotations.dispose()
  }
}
