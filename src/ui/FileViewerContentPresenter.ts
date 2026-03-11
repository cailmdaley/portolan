import { type FileViewerAnnotations } from './FileViewerAnnotations'
import { FileViewerContentLoader } from './FileViewerContentLoader'
import { FileViewerMarkdownView } from './FileViewerMarkdownView'
import { FileViewerTextEditor } from './FileViewerTextEditor'

interface FileViewerContentPresenterOptions {
  pathEl: HTMLElement
  langEl: HTMLElement
  contentEl: HTMLElement
  modeLineEl: HTMLElement
  saveBtn: HTMLElement
  copyBtn: HTMLElement
  downloadBtn: HTMLElement
  annotations: FileViewerAnnotations
  textEditor: FileViewerTextEditor
  markdownView: FileViewerMarkdownView
}

interface ShowFileOptions {
  filePath: string
  originId: string
  sourceWorkerId?: string
  cityPath?: string
  cityId?: string
  jumpToLine?: number
  focusEditor?: boolean
}

export class FileViewerContentPresenter {
  private pathEl: HTMLElement
  private langEl: HTMLElement
  private contentEl: HTMLElement
  private modeLineEl: HTMLElement
  private saveBtn: HTMLElement
  private copyBtn: HTMLElement
  private downloadBtn: HTMLElement
  private annotations: FileViewerAnnotations
  private textEditor: FileViewerTextEditor
  private markdownView: FileViewerMarkdownView
  private contentLoader: FileViewerContentLoader

  private currentPath = ''
  private currentOriginId = 'local'
  private currentCityPath = ''
  private currentCityId = ''
  private sourceWorkerId: string | null = null
  private activeShowRequestId = 0
  private activeShowAbortController: AbortController | null = null

  constructor(options: FileViewerContentPresenterOptions) {
    this.pathEl = options.pathEl
    this.langEl = options.langEl
    this.contentEl = options.contentEl
    this.modeLineEl = options.modeLineEl
    this.saveBtn = options.saveBtn
    this.copyBtn = options.copyBtn
    this.downloadBtn = options.downloadBtn
    this.annotations = options.annotations
    this.textEditor = options.textEditor
    this.markdownView = options.markdownView
    this.contentLoader = new FileViewerContentLoader({
      pathEl: this.pathEl,
      langEl: this.langEl,
      contentEl: this.contentEl,
      modeLineEl: this.modeLineEl,
      saveBtn: this.saveBtn,
      copyBtn: this.copyBtn,
      downloadBtn: this.downloadBtn,
      annotations: this.annotations,
      textEditor: this.textEditor,
      markdownView: this.markdownView,
    })
  }

  getCurrentPath(): string {
    return this.currentPath
  }

  getCurrentOriginId(): string {
    return this.currentOriginId
  }

  getCurrentCityPath(): string {
    return this.currentCityPath
  }

  getCurrentCityId(): string {
    return this.currentCityId
  }

  getSourceWorkerId(): string | null {
    return this.sourceWorkerId
  }

  getRuntimeStats(): {
    currentPath: string | null
    currentOriginId: string
    activeShowRequestId: number
    hasActiveShowRequest: boolean
  } {
    return {
      currentPath: this.currentPath || null,
      currentOriginId: this.currentOriginId,
      activeShowRequestId: this.activeShowRequestId,
      hasActiveShowRequest: this.activeShowAbortController !== null,
    }
  }

  async show(options: ShowFileOptions): Promise<void> {
    const { requestId, signal } = this.beginShowRequest()
    this.markdownView.reset()

    try {
      this.pathEl.textContent = options.filePath
      this.pathEl.classList.remove('dirty')
      this.langEl.textContent = 'loading...'
      this.contentEl.innerHTML = '<pre><code>Loading...</code></pre>'
      this.modeLineEl.textContent = ''
      this.saveBtn.style.display = 'none'
      this.copyBtn.style.display = 'none'
      this.downloadBtn.style.display = 'none'
      this.textEditor.reset()

      this.currentPath = options.filePath
      this.currentOriginId = options.originId
      this.currentCityPath = options.cityPath || ''
      this.currentCityId = options.cityId || ''
      this.sourceWorkerId = options.sourceWorkerId || null

      this.annotations.reset()
      this.annotations.hideSelectionToolbar()

      await this.contentLoader.showFile({
        filePath: options.filePath,
        originId: options.originId,
        jumpToLine: options.jumpToLine,
        focusEditor: options.focusEditor,
        signal,
        isRequestActive: () => this.isShowRequestActive(requestId),
      })
    } finally {
      this.finishShowRequest(requestId)
    }
  }

  hide(): void {
    this.cancelActiveShowRequest()
    this.markdownView.reset()
    this.textEditor.reset()
    this.currentPath = ''
    this.currentCityPath = ''
    this.currentCityId = ''
    this.sourceWorkerId = null
  }

  private beginShowRequest(): { requestId: number; signal: AbortSignal } {
    this.activeShowAbortController?.abort()
    const controller = new AbortController()
    this.activeShowAbortController = controller
    this.activeShowRequestId += 1
    return { requestId: this.activeShowRequestId, signal: controller.signal }
  }

  private isShowRequestActive(requestId: number): boolean {
    return requestId === this.activeShowRequestId
  }

  private finishShowRequest(requestId: number): void {
    if (this.isShowRequestActive(requestId)) {
      this.activeShowAbortController = null
    }
  }

  private cancelActiveShowRequest(): void {
    this.activeShowAbortController?.abort()
    this.activeShowAbortController = null
    this.activeShowRequestId += 1
  }

}
