import { escapeHtml } from './utils'
import type { Annotation } from './FileViewerAnnotationTypes'
import { type FileViewerAnnotations } from './FileViewerAnnotations'
import { FileViewerMarkdownView } from './FileViewerMarkdownView'
import {
  type FileContent,
  FileViewerTextEditor,
} from './FileViewerTextEditor'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'])
const PDF_EXTENSIONS = new Set(['.pdf'])
const HTML_EXTENSIONS = new Set(['.html'])
const API_BASE = `http://${window.location.hostname}:4004`

interface FileViewerContentLoaderOptions {
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
  jumpToLine?: number
  focusEditor?: boolean
  cacheBust?: boolean
  preserveHtmlUrl?: string
  signal: AbortSignal
  isRequestActive: () => boolean
}

export class FileViewerContentLoader {
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
  private currentHtmlView: { frameId: string; url: string } | null = null
  private currentSlideState: { slide: number; slideV: number; total: number; title: string } | null = null
  private onSlideChange: ((slide: number, slideV: number, total: number, title: string) => void) | null = null
  private readonly htmlStateMessageType = 'portolan-html-location'
  private messageHandler: ((event: MessageEvent) => void) | null = null

  constructor(options: FileViewerContentLoaderOptions) {
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
    this.messageHandler = (event: MessageEvent) => this.handleHtmlViewMessage(event)
    window.addEventListener('message', this.messageHandler)
  }

  async showFile(options: ShowFileOptions): Promise<void> {
    const { filePath, originId, cacheBust, preserveHtmlUrl, signal, isRequestActive } = options
    const ext = this.getExtension(filePath)

    if (IMAGE_EXTENSIONS.has(ext)) {
      this.resetHtmlView()
      await this.showImage(filePath, originId, signal, isRequestActive, cacheBust)
      return
    }

    if (PDF_EXTENSIONS.has(ext)) {
      this.resetHtmlView()
      this.showPdf(filePath, originId, signal, isRequestActive, cacheBust)
      return
    }

    if (HTML_EXTENSIONS.has(ext)) {
      this.showHtml(filePath, originId, signal, isRequestActive, cacheBust, preserveHtmlUrl)
      return
    }

    this.resetHtmlView()

    try {
      const bustSuffix = cacheBust ? `&_t=${Date.now()}` : ''
      const [contentResponse, annotationsResponse] = await Promise.all([
        fetch(
          `${API_BASE}/file-content?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}${bustSuffix}`,
          { signal },
        ),
        fetch(
          `${API_BASE}/annotations?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}`,
          { signal },
        ),
      ])
      if (!isRequestActive()) return

      if (!contentResponse.ok) {
        const error = await contentResponse.json()
        throw new Error(error.error || 'Failed to load file')
      }

      const data: FileContent = await contentResponse.json()
      if (!isRequestActive()) return

      this.textEditor.setCurrentContent(data)
      if (annotationsResponse.ok) {
        const annotationsData = await annotationsResponse.json()
        if (!isRequestActive()) return
        this.annotations.setAnnotations(annotationsData.annotations || [])
      } else {
        this.annotations.setAnnotations([])
      }

      this.pathEl.textContent = data.path
      this.langEl.textContent = data.language
      this.saveBtn.style.display = 'inline-block'
      this.copyBtn.style.display = 'inline-block'
      this.downloadBtn.style.display = 'inline-block'

      const isMarkdown = data.language === 'markdown' || /\.(md|markdown)$/i.test(filePath)
      if (isMarkdown) {
        this.markdownView.show(data.content)
      } else {
        this.textEditor.showEditor(options.jumpToLine, options.focusEditor !== false)
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || !isRequestActive()) {
        return
      }
      this.showError(error.message)
    }
  }

  private getExtension(filePath: string): string {
    const match = filePath.match(/\.[^.]+$/)
    return match ? match[0].toLowerCase() : ''
  }

  private buildRawFileUrl(filePath: string, originId: string, cacheBust?: boolean): string {
    let url = `${API_BASE}/file-content?path=${encodeURIComponent(filePath)}&raw=true`
    if (originId && originId !== 'local') {
      url += `&originId=${encodeURIComponent(originId)}`
    }
    if (cacheBust) {
      url += `&_t=${Date.now()}`
    }
    return url
  }

  private buildProjectFileUrl(filePath: string, originId: string): string {
    const encodedPath = filePath
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/')
    return `${API_BASE}/project-file/${encodeURIComponent(originId)}${encodedPath}`
  }

  private buildHtmlViewUrl(
    filePath: string,
    originId: string,
    frameId: string,
    cacheBust?: boolean,
    preserveUrl?: string,
  ): string {
    const baseUrl = this.buildProjectFileUrl(filePath, originId)
    const url = new URL(preserveUrl || baseUrl)
    url.searchParams.set('_portolan_frame', frameId)
    if (cacheBust) {
      url.searchParams.set('_t', `${Date.now()}`)
    } else {
      url.searchParams.delete('_t')
    }
    return url.toString()
  }

  getCurrentHtmlViewUrl(): string | null {
    return this.currentHtmlView?.url || null
  }

  getCurrentSlideState(): { slide: number; slideV: number; total: number; title: string } | null {
    return this.currentSlideState
  }

  setOnSlideChange(fn: ((slide: number, slideV: number, total: number, title: string) => void) | null): void {
    this.onSlideChange = fn
  }

  gotoSlide(slideIndex: number, slideIndexV: number = 0): void {
    if (!this.currentHtmlView) return
    const iframe = this.contentEl.querySelector('iframe') as HTMLIFrameElement | null
    iframe?.contentWindow?.postMessage({
      type: 'portolan-reveal-goto',
      frameId: this.currentHtmlView.frameId,
      slideIndex,
      slideIndexV: slideIndexV,
    }, '*')
  }

  resetHtmlView(): void {
    this.currentHtmlView = null
    this.currentSlideState = null
  }

  dispose(): void {
    this.resetHtmlView()
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler)
      this.messageHandler = null
    }
  }

  private handleHtmlViewMessage(event: MessageEvent): void {
    if (event.origin !== API_BASE) return
    const data = event.data
    if (!data || !this.currentHtmlView) return
    if (data.frameId !== this.currentHtmlView.frameId) return

    if (data.type === this.htmlStateMessageType && typeof data.href === 'string') {
      this.currentHtmlView.url = data.href
    } else if (data.type === 'portolan-reveal-slide') {
      const title = typeof data.slideTitle === 'string' ? data.slideTitle : ''
      this.currentSlideState = {
        slide: data.slideIndex,
        slideV: data.slideIndexV || 0,
        total: data.totalSlides,
        title,
      }
      this.onSlideChange?.(data.slideIndex, data.slideIndexV || 0, data.totalSlides, title)
    }
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
    signal: AbortSignal,
    isRequestActive: () => boolean,
    cacheBust?: boolean,
  ): Promise<void> {
    this.langEl.textContent = 'image'
    this.modeLineEl.textContent = 'Click to annotate'
    this.textEditor.setCurrentContent(null)

    try {
      const rawUrl = this.buildRawFileUrl(filePath, originId, cacheBust)
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
      if (!isRequestActive()) return

      this.annotations.setAnnotations(annotations)
      this.annotations.setupImageAnnotation(container, img)
      this.annotations.renderImageAnnotationMarkers(container)
    } catch (error: any) {
      if (error?.name === 'AbortError' || !isRequestActive()) {
        return
      }
      this.showError(error.message)
    }
  }

  private showPdf(
    filePath: string,
    originId: string,
    signal: AbortSignal,
    isRequestActive: () => boolean,
    cacheBust?: boolean,
  ): void {
    this.langEl.textContent = 'pdf'
    this.modeLineEl.textContent = ''
    this.textEditor.setCurrentContent(null)

    if (signal.aborted || !isRequestActive()) return

    const container = document.createElement('div')
    container.className = 'file-viewer-pdf'
    container.innerHTML = `<iframe src="${this.buildRawFileUrl(filePath, originId, cacheBust)}" title="${escapeHtml(filePath)}" />`
    this.contentEl.innerHTML = ''
    this.contentEl.appendChild(container)
  }

  private async showHtml(
    filePath: string,
    originId: string,
    signal: AbortSignal,
    isRequestActive: () => boolean,
    cacheBust?: boolean,
    preserveHtmlUrl?: string,
  ): Promise<void> {
    this.langEl.textContent = 'html'
    this.modeLineEl.textContent = ''
    this.textEditor.setCurrentContent(null)

    if (signal.aborted || !isRequestActive()) return

    const frameId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const iframeUrl = this.buildHtmlViewUrl(filePath, originId, frameId, cacheBust, preserveHtmlUrl)
    this.currentHtmlView = { frameId, url: iframeUrl }
    this.currentSlideState = null

    const container = document.createElement('div')
    container.className = 'file-viewer-pdf'
    const iframe = document.createElement('iframe')
    iframe.src = iframeUrl
    iframe.title = filePath
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.border = 'none'
    container.appendChild(iframe)
    this.contentEl.innerHTML = ''
    this.contentEl.appendChild(container)

    // Fetch annotations for HTML files
    try {
      const annotations = await this.fetchFileAnnotations(filePath, originId, signal)
      if (!isRequestActive()) return
      this.annotations.setAnnotations(annotations)
    } catch (error: any) {
      if (error?.name === 'AbortError' || !isRequestActive()) return
      this.annotations.setAnnotations([])
    }
  }

  private showError(message: string): void {
    this.langEl.textContent = 'error'
    this.contentEl.innerHTML = `<pre><code class="error">Error: ${message}</code></pre>`
  }
}
