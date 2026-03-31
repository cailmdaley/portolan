import {
  loadAnnotations,
  saveImageAnnotation as persistImageAnnotation,
  saveSlideAnnotation as persistSlideAnnotation,
} from './FileViewerAnnotationActions'
import { AnnotationPanel } from './AnnotationPanel'
import type { Annotation } from './FileViewerAnnotationTypes'
import { escapeHtml } from './utils'

interface FileViewerAnnotationPanelState {
  currentPath: string
  currentOriginId: string
  isVisible: boolean
  editorView: {
    dispatch: (spec: {
      selection: { anchor: number; head: number }
      scrollIntoView: boolean
    }) => void
  } | null
}

interface FileViewerAnnotationPanelControllerHost {
  panelEl: HTMLElement
  contentEl: HTMLElement
  getState: () => FileViewerAnnotationPanelState
  scheduleDeferredUiTask: (task: () => void, delayMs: number) => number
  onAnnotationsChanged: (annotations: Annotation[]) => void
  onGotoSlide?: (slideIndex: number) => void
}

export class FileViewerAnnotationPanelController {
  private host: FileViewerAnnotationPanelControllerHost
  private annotationPanel: AnnotationPanel<Annotation>
  private annotations: Annotation[] = []
  private currentSlide: number | null = null
  private currentSlideTitle = ''
  private slideAnnotateBtn: HTMLButtonElement | null = null

  constructor(host: FileViewerAnnotationPanelControllerHost) {
    this.host = host
    this.annotationPanel = new AnnotationPanel<Annotation>(host.panelEl, {
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
  }

  reset(): void {
    this.annotations = []
    this.annotationPanel.reset()
    this.host.onAnnotationsChanged(this.annotations)
  }

  setAnnotations(annotations: Annotation[]): void {
    this.annotations = [...annotations]
    this.annotationPanel.setAnnotations(this.annotations)
    this.host.onAnnotationsChanged(this.annotations)
  }

  addAnnotation(annotation: Annotation): void {
    this.annotations.push(annotation)
    this.annotationPanel.setAnnotations(this.annotations)
    this.host.onAnnotationsChanged(this.annotations)
  }

  getAnnotations(): Annotation[] {
    return this.annotations
  }

  hasContent(): boolean {
    return this.annotationPanel.hasContent()
  }

  getGlobalComment(): string {
    return this.annotationPanel.getGlobalComment()
  }

  resetGlobalComment(): void {
    this.annotationPanel.resetGlobalInput()
  }

  async saveImageAnnotation(x: number, y: number, comment: string): Promise<Annotation | null> {
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
      this.addAnnotation(annotation)
      return annotation
    } catch (error: any) {
      console.error('Failed to save image annotation:', error)
      alert(`Failed to save annotation: ${error.message}`)
      return null
    }
  }

  setCurrentSlide(slide: number | null, title?: string): void {
    this.currentSlide = slide
    this.currentSlideTitle = title || ''

    if (slide !== null && !this.slideAnnotateBtn) {
      const btn = document.createElement('button')
      btn.className = 'ann-panel-slide-annotate'
      btn.title = 'Annotate current slide'
      btn.textContent = '+ Slide'
      btn.addEventListener('click', () => {
        if (this.currentSlide !== null) {
          void this.addSlideAnnotationStub(this.currentSlide, this.currentSlideTitle)
        }
      })
      const headerActions = this.host.panelEl.querySelector('.ann-panel-header-actions')
      if (headerActions) {
        headerActions.insertBefore(btn, headerActions.firstChild)
      }
      this.slideAnnotateBtn = btn
    } else if (slide === null && this.slideAnnotateBtn) {
      this.slideAnnotateBtn.remove()
      this.slideAnnotateBtn = null
    }
  }

  private async addSlideAnnotationStub(slide: number, title: string): Promise<void> {
    const annotation = await this.saveSlideAnnotation(slide, '...', title)
    if (annotation) {
      this.annotationPanel.startEditById(annotation.id)
    }
  }

  async saveSlideAnnotation(slide: number, comment: string, slideTitle?: string): Promise<Annotation | null> {
    const { currentPath, currentOriginId } = this.host.getState()
    if (!currentPath) return null

    try {
      const annotation = await persistSlideAnnotation({
        currentPath,
        currentOriginId,
        slide,
        slideTitle,
        comment,
      })
      const state = this.host.getState()
      if (!state.isVisible || state.currentPath !== currentPath || state.currentOriginId !== currentOriginId) {
        return null
      }
      this.addAnnotation(annotation)
      return annotation
    } catch (error: any) {
      console.error('Failed to save slide annotation:', error)
      alert(`Failed to save annotation: ${error.message}`)
      return null
    }
  }

  async reloadAnnotations(): Promise<void> {
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

  private renderPreview(ann: Annotation, index: number): string {
    if (ann.isImageAnnotation) {
      return `<span class="annotation-line">#${index + 1}</span> <em style="color: var(--text-muted);">[Image point]</em>`
    }

    if (ann.isSlideAnnotation && ann.slide !== undefined) {
      const title = ann.slideTitle ? `: ${escapeHtml(ann.slideTitle)}` : ''
      return `<span class="annotation-line">S${ann.slide + 1}</span> <em style="color: var(--text-muted);">[Slide ${ann.slide + 1}${title}]</em>`
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

    if (annotation.isSlideAnnotation && annotation.slide !== undefined) {
      this.host.onGotoSlide?.(annotation.slide)
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
