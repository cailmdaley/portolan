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
  }

  async showFile(options: ShowFileOptions): Promise<void> {
    const { filePath, originId, signal, isRequestActive } = options
    const ext = this.getExtension(filePath)

    if (IMAGE_EXTENSIONS.has(ext)) {
      await this.showImage(filePath, originId, signal, isRequestActive)
      return
    }

    if (PDF_EXTENSIONS.has(ext)) {
      this.showPdf(filePath, originId, signal, isRequestActive)
      return
    }

    try {
      const [contentResponse, annotationsResponse] = await Promise.all([
        fetch(
          `${API_BASE}/file-content?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}`,
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
    signal: AbortSignal,
    isRequestActive: () => boolean,
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
  ): void {
    this.langEl.textContent = 'pdf'
    this.modeLineEl.textContent = ''
    this.textEditor.setCurrentContent(null)

    if (signal.aborted || !isRequestActive()) return

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
