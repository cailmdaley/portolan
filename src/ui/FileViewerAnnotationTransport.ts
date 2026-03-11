import {
  fileAnnotationsAsFiber,
  sendAnnotationsToWorker as persistAnnotationsToWorker,
} from './FileViewerAnnotationActions'
import type { AnnotationPanel } from './AnnotationPanel'
import type { Annotation } from './FileViewerAnnotationTypes'
import { type WorkerInfo, showWorkerPicker } from './WorkerPicker'
import { showToast } from './utils'

interface FileViewerAnnotationTransportState {
  currentPath: string
  currentOriginId: string
  currentCityPath: string
  sourceWorkerId: string | null
  isVisible: boolean
}

interface FileViewerAnnotationTransportHost {
  panelEl: HTMLElement
  sendBtn: HTMLElement
  fiberBtn: HTMLElement
  annotationPanel: AnnotationPanel<Annotation>
  getState: () => FileViewerAnnotationTransportState
  getAnnotations: () => Annotation[]
  scheduleDeferredUiTask: (task: () => void, delayMs: number) => number
}

export class FileViewerAnnotationTransport {
  private host: FileViewerAnnotationTransportHost
  private cityWorkers: WorkerInfo[] = []
  private onGetWorkers: ((originId: string, path: string) => Promise<WorkerInfo[]>) | null = null

  constructor(host: FileViewerAnnotationTransportHost) {
    this.host = host
    this.setupEventListeners()
  }

  setOnGetWorkers(fn: (originId: string, path: string) => Promise<WorkerInfo[]>): void {
    this.onGetWorkers = fn
  }

  reset(): void {
    this.cityWorkers = []
    this.updateActionButtons()
  }

  updateActionButtons(): void {
    const visible = this.host.annotationPanel.hasContent() ? 'inline-block' : 'none'
    this.host.sendBtn.style.display = visible
    this.host.fiberBtn.style.display = visible
  }

  async showWorkerPicker(): Promise<void> {
    const { currentPath, currentOriginId, sourceWorkerId } = this.host.getState()
    if (!currentPath || !this.host.annotationPanel.hasContent()) return

    if (sourceWorkerId) {
      await this.sendAnnotationsToWorker(this.host.getAnnotations(), sourceWorkerId)
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

    showWorkerPicker(this.cityWorkers, this.host.getAnnotations().length, {
      onSelectWorker: (workerId) => this.sendAnnotationsToWorker(this.host.getAnnotations(), workerId),
      onNewWorker: () => this.sendAnnotationsToWorker(this.host.getAnnotations(), undefined, true),
    })
  }

  async fileAsFiber(): Promise<void> {
    const { currentPath, currentOriginId, currentCityPath } = this.host.getState()
    if (!currentPath || !this.host.annotationPanel.hasContent()) return

    try {
      this.host.fiberBtn.textContent = 'Filing...'
      this.host.fiberBtn.setAttribute('disabled', 'true')

      const result = await fileAnnotationsAsFiber({
        currentPath,
        currentOriginId,
        currentCityPath,
        annotations: this.host.getAnnotations(),
        globalComment: this.host.annotationPanel.getGlobalComment(),
      })
      this.host.annotationPanel.resetGlobalInput()
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

  private setupEventListeners(): void {
    const globalCommentTextarea = this.host.panelEl.querySelector('.ann-panel-global-input textarea') as HTMLTextAreaElement | null
    globalCommentTextarea?.addEventListener('input', () => {
      this.updateActionButtons()
    })

    this.host.sendBtn.addEventListener('click', () => {
      void this.showWorkerPicker()
    })
    this.host.fiberBtn.addEventListener('click', () => {
      void this.fileAsFiber()
    })
  }

  private async sendAnnotationsToWorker(
    annotations: Annotation[],
    workerId?: string,
    createNew?: boolean,
  ): Promise<void> {
    const { currentPath, currentOriginId, isVisible } = this.host.getState()
    const globalComment = this.host.annotationPanel.getGlobalComment()
    if (!currentPath || (annotations.length === 0 && globalComment.length === 0)) return

    try {
      await persistAnnotationsToWorker({
        currentPath,
        currentOriginId,
        workerId,
        createNew,
        annotations,
        globalComment,
      })

      this.host.annotationPanel.resetGlobalInput()
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
