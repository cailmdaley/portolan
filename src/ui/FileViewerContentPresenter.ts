import { escapeHtml } from './utils'
import {
  type Annotation,
  type FileViewerAnnotations,
} from './FileViewerAnnotations'
import { FileViewerMarkdownView } from './FileViewerMarkdownView'
import {
  type FileContent,
  FileViewerTextEditor,
} from './FileViewerTextEditor'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'])
const PDF_EXTENSIONS = new Set(['.pdf'])
const API_BASE = `http://${window.location.hostname}:4004`

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

      const ext = this.getExtension(options.filePath)
      if (IMAGE_EXTENSIONS.has(ext)) {
        await this.showImage(options.filePath, options.originId, requestId, signal)
        return
      }

      if (PDF_EXTENSIONS.has(ext)) {
        this.showPdf(options.filePath, options.originId, requestId, signal)
        return
      }

      try {
        const [contentResponse, annotationsResponse] = await Promise.all([
          fetch(
            `${API_BASE}/file-content?path=${encodeURIComponent(options.filePath)}&originId=${encodeURIComponent(options.originId)}`,
            { signal },
          ),
          fetch(
            `${API_BASE}/annotations?path=${encodeURIComponent(options.filePath)}&originId=${encodeURIComponent(options.originId)}`,
            { signal },
          ),
        ])
        if (!this.isShowRequestActive(requestId)) return

        if (!contentResponse.ok) {
          const error = await contentResponse.json()
          throw new Error(error.error || 'Failed to load file')
        }

        const data: FileContent = await contentResponse.json()
        if (!this.isShowRequestActive(requestId)) return

        this.textEditor.setCurrentContent(data)
        if (annotationsResponse.ok) {
          const annotationsData = await annotationsResponse.json()
          if (!this.isShowRequestActive(requestId)) return
          this.annotations.setAnnotations(annotationsData.annotations || [])
        } else {
          this.annotations.setAnnotations([])
        }

        this.pathEl.textContent = data.path
        this.langEl.textContent = data.language
        this.saveBtn.style.display = 'inline-block'
        this.copyBtn.style.display = 'inline-block'
        this.downloadBtn.style.display = 'inline-block'

        const isMarkdown = data.language === 'markdown' || /\.(md|markdown)$/i.test(options.filePath)
        if (isMarkdown) {
          this.markdownView.show(data.content)
        } else {
          this.textEditor.showEditor(options.jumpToLine, options.focusEditor !== false)
        }
      } catch (error: any) {
        if (error?.name === 'AbortError' || !this.isShowRequestActive(requestId)) {
          return
        }
        this.showError(error.message)
      }
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

  private getExtension(filePath: string): string {
    const match = filePath.match(/\.[^.]+$/)
    return match ? match[0].toLowerCase() : ''
  }

  private buildRawFileUrl(filePath: string, originId: string): string {
    let url = `${API_BASE}/file-content?path=${encodeURIComponent(filePath)}&raw=true`
    if (originId && originId !== 'local') {
      url += `&originId=${encodeURIComponent(originId)}`
    }
    return url
  }

  private waitForImageLoad(img: HTMLImageElement, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        img.removeEventListener('load', onLoad)
        img.removeEventListener('error', onError)
      }
      const onAbort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const onLoad = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('Failed to load image'))
      }

      signal.addEventListener('abort', onAbort, { once: true })
      img.addEventListener('load', onLoad, { once: true })
      img.addEventListener('error', onError, { once: true })

      if (img.complete) {
        cleanup()
        if (img.naturalWidth > 0) {
          resolve()
        } else {
          reject(new Error('Failed to load image'))
        }
      }
    })
  }

  private async fetchFileAnnotations(filePath: string, originId: string, signal: AbortSignal): Promise<Annotation[]> {
    try {
      const response = await fetch(
        `${API_BASE}/annotations?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}`,
        { signal },
      )
      if (!response.ok) return []
      const data = await response.json()
      return Array.isArray(data.annotations) ? data.annotations : []
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error
      console.error('Failed to load annotations:', error)
      return []
    }
  }

  private async showImage(
    filePath: string,
    originId: string,
    requestId: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.langEl.textContent = 'image'
    this.modeLineEl.textContent = 'Click to annotate'
    this.textEditor.setCurrentContent(null)

    try {
      const rawUrl = this.buildRawFileUrl(filePath, originId)
      const container = document.createElement('div')
      container.className = 'file-viewer-image'
      const img = document.createElement('img')
      img.alt = filePath
      container.appendChild(img)
      this.contentEl.innerHTML = ''
      this.contentEl.appendChild(container)

      img.src = rawUrl
      const imageLoadPromise = this.waitForImageLoad(img, signal)
      const annotationsPromise = this.fetchFileAnnotations(filePath, originId, signal)

      const [annotations] = await Promise.all([annotationsPromise, imageLoadPromise])
      if (!this.isShowRequestActive(requestId)) return

      this.annotations.setAnnotations(annotations)
      this.annotations.setupImageAnnotation(container, img)
      this.annotations.renderImageAnnotationMarkers(container)
    } catch (error: any) {
      if (error?.name === 'AbortError' || !this.isShowRequestActive(requestId)) {
        return
      }
      this.showError(error.message)
    }
  }

  private showPdf(filePath: string, originId: string, requestId: number, signal: AbortSignal): void {
    this.langEl.textContent = 'pdf'
    this.modeLineEl.textContent = ''
    this.textEditor.setCurrentContent(null)

    if (signal.aborted || !this.isShowRequestActive(requestId)) return

    const container = document.createElement('div')
    container.className = 'file-viewer-pdf'
    container.innerHTML = `<iframe src="${this.buildRawFileUrl(filePath, originId)}" title="${escapeHtml(filePath)}" />`
    this.contentEl.innerHTML = ''
    this.contentEl.appendChild(container)
  }

  private showError(message: string): void {
    this.langEl.textContent = 'error'
    this.contentEl.innerHTML = `<pre><code class="error">Error: ${message}</code></pre>`
  }
}
