import { Vim } from '@replit/codemirror-vim'
import { escapeHtml } from './utils'
import { AnnotationPanel } from './AnnotationPanel'
import { type WorkerInfo } from './WorkerPicker'
import {
  type Annotation,
  FileViewerAnnotations,
} from './FileViewerAnnotations'
import { FileViewerMarkdownView } from './FileViewerMarkdownView'
import { type FileContent, FileViewerTextEditor } from './FileViewerTextEditor'

// Image file extensions
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'])

// PDF extension
const PDF_EXTENSIONS = new Set(['.pdf'])

const API_BASE = `http://${window.location.hostname}:4004`

export class FileViewerModal {
  private backdrop: HTMLElement
  private modal: HTMLElement
  private pathEl: HTMLElement
  private langEl: HTMLElement
  private refreshBtn: HTMLElement
  private copyBtn: HTMLElement
  private downloadBtn: HTMLElement
  private saveBtn: HTMLElement
  private sendBtn: HTMLElement
  private fiberBtn: HTMLElement
  private closeBtn: HTMLElement
  // @ts-expect-error Stored for potential future layout changes
  private contentWrapper: HTMLElement
  private contentEl: HTMLElement
  private annotationsPanelEl: HTMLElement
  private annotations: FileViewerAnnotations
  private textEditor: FileViewerTextEditor
  private modeLineEl: HTMLElement
  private currentPath: string = ''
  private currentOriginId: string = 'local'
  private currentCityPath: string = ''
  private currentCityId: string = ''
  private sourceWorkerId: string | null = null

  // Navigation state for cycling through files with Up/Down
  private navigationFiles: string[] = []
  private navigationIndex: number = -1
  private skipEditorFocus: boolean = false

  // Double-Escape tracking for vim: first Escape -> normal mode, second Escape -> close
  private lastEscapeTime: number = 0

  private markdownView: FileViewerMarkdownView

  // Handler refs for HMR cleanup
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private arrowHandler: ((e: KeyboardEvent) => void) | null = null

  // Async request ownership for race-safe modal loads
  private activeShowRequestId: number = 0
  private activeShowAbortController: AbortController | null = null
  private deferredUiTimers = new Set<number>()

  constructor() {
    this.backdrop = this.createBackdrop()
    this.modal = this.createModal()
    this.pathEl = this.modal.querySelector('.file-viewer-path')!
    this.langEl = this.modal.querySelector('.file-viewer-lang')!
    this.refreshBtn = this.modal.querySelector('.file-viewer-refresh')!
    this.copyBtn = this.modal.querySelector('.file-viewer-copy')!
    this.downloadBtn = this.modal.querySelector('.file-viewer-download')!
    this.saveBtn = this.modal.querySelector('.file-viewer-save')!
    this.sendBtn = this.modal.querySelector('.file-viewer-send')!
    this.fiberBtn = this.modal.querySelector('.file-viewer-fiber')!
    this.closeBtn = this.modal.querySelector('.file-viewer-close')!
    this.contentWrapper = this.modal.querySelector('.file-viewer-content-wrapper')!
    this.contentEl = this.modal.querySelector('.file-viewer-content')!
    this.annotationsPanelEl = this.modal.querySelector('.file-viewer-annotations')!
    this.modeLineEl = this.modal.querySelector('.file-viewer-modeline')!

    this.annotations = new FileViewerAnnotations(this.annotationsPanelEl, {
      modalEl: this.modal,
      contentEl: this.contentEl,
      sendBtn: this.sendBtn,
      fiberBtn: this.fiberBtn,
      getState: () => ({
        currentPath: this.currentPath,
        currentOriginId: this.currentOriginId,
        currentCityPath: this.currentCityPath,
        sourceWorkerId: this.sourceWorkerId,
        originalContent: this.textEditor.getOriginalContent(),
        editorView: this.textEditor.getEditorView(),
        isVisible: this.isVisible(),
      }),
      scheduleDeferredUiTask: (task, delayMs) => this.scheduleDeferredUiTask(task, delayMs),
    })
    this.textEditor = new FileViewerTextEditor({
      contentEl: this.contentEl,
      pathEl: this.pathEl,
      modeLineEl: this.modeLineEl,
      saveBtn: this.saveBtn,
      copyBtn: this.copyBtn,
      downloadBtn: this.downloadBtn,
      annotations: this.annotations,
      scheduleDeferredUiTask: (task, delayMs) => this.scheduleDeferredUiTask(task, delayMs),
      getOriginId: () => this.currentOriginId,
      isVisible: () => this.isVisible(),
      onRenderMarkdown: (content) => this.markdownView.show(content),
    })
    this.markdownView = new FileViewerMarkdownView({
      contentEl: this.contentEl,
      modeLineEl: this.modeLineEl,
      annotations: this.annotations,
      getState: () => ({
        currentPath: this.currentPath,
        currentOriginId: this.currentOriginId,
        currentCityPath: this.currentCityPath,
        currentCityId: this.currentCityId,
        isVisible: this.isVisible(),
      }),
      onOpenPath: (path, originId, cityPath, cityId, line) => {
        this.show(path, originId, undefined, undefined, cityPath, cityId, line)
      },
      onEnterEditMode: () => this.textEditor.enterMarkdownEditMode(),
    })

    this.setupEventListeners()
    this.setupVimCommands()
    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.modal)
  }

  private createBackdrop(): HTMLElement {
    const backdrop = document.createElement('div')
    backdrop.className = 'file-viewer-backdrop'
    return backdrop
  }

  private createModal(): HTMLElement {
    const modal = document.createElement('div')
    modal.className = 'file-viewer-modal'
    modal.innerHTML = `
      <div class="file-viewer-header">
        <span class="file-viewer-path"></span>
        <div class="file-viewer-actions">
          <span class="file-viewer-lang"></span>
          <button class="file-viewer-btn file-viewer-save" style="display: none;">Save</button>
          <button class="file-viewer-btn file-viewer-fiber" style="display: none;">File as Fiber</button>
          <button class="file-viewer-btn file-viewer-send" style="display: none;">Send to Worker</button>
          <button class="file-viewer-btn file-viewer-refresh" title="Refresh file">\u21BB</button>
          <button class="file-viewer-btn file-viewer-copy">Copy</button>
          <button class="file-viewer-btn file-viewer-download">Download</button>
          <button class="file-viewer-close">&times;</button>
        </div>
      </div>
      <div class="file-viewer-content-wrapper">
        <div class="file-viewer-content"></div>
        <div class="file-viewer-annotations">
          ${AnnotationPanel.buildPanelHTML({
            globalCommentPlaceholder: 'Add summary or overall context...',
            globalCommentLabel: 'Overall feedback:',
          })}
        </div>
      </div>
      <div class="file-viewer-modeline"></div>
    `
    return modal
  }

  private setupEventListeners(): void {
    // Close on backdrop click - stop propagation so parent panels don't close
    this.backdrop.addEventListener('click', (e) => {
      e.stopPropagation()
      this.tryClose()
    })

    // Close button - stop propagation so parent panels don't close
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.tryClose()
    })

    // Copy button
    this.copyBtn.addEventListener('click', () => this.textEditor.copyToClipboard())

    // Download button
    this.downloadBtn.addEventListener('click', () => this.textEditor.download())

    // Refresh button
    this.refreshBtn.addEventListener('click', () => this.refresh())

    // Save button
    this.saveBtn.addEventListener('click', () => this.textEditor.save())

    // Document-level handlers are attached in show(), detached in hide()
    // This prevents HMR stacking where old listeners accumulate across hot reloads
  }

  private attachDocumentHandlers(): void {
    // Only attach if not already attached
    if (this.escapeHandler) return

    // Escape key to close the file viewer
    // For vim: first Escape -> normal mode, second Escape (within 1s) -> close
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.modal.classList.contains('visible')) return

      // Hide selection toolbar first
      if (this.annotations.hasSelectionToolbar()) {
        this.annotations.hideSelectionToolbar()
        e.stopPropagation()
        return
      }

      const now = Date.now()

      // If editing a markdown file, Escape returns to rendered view
      if (this.textEditor.hasEditorFocus() && !this.markdownView.isActive() && this.textEditor.isMarkdownFile(this.currentPath)) {
        if (now - this.lastEscapeTime < 1000) {
          if (this.textEditor.getIsDirty()) {
            this.textEditor.save().then(() => this.textEditor.exitMarkdownEditMode())
          } else {
            this.textEditor.exitMarkdownEditMode()
          }
          e.stopPropagation()
          this.lastEscapeTime = 0
          return
        } else {
          this.lastEscapeTime = now
          return
        }
      }

      // If editor exists and has focus, use double-Escape
      if (this.textEditor.hasEditorFocus()) {
        // Second Escape within 1 second -> close
        if (now - this.lastEscapeTime < 1000) {
          this.tryClose()
          e.stopPropagation()
          this.lastEscapeTime = 0
        } else {
          // First Escape -> let vim handle it, record time
          this.lastEscapeTime = now
          // Don't stop propagation - let vim see it
        }
        return
      }

      // No editor or not focused -> close immediately
      this.tryClose()
      e.stopPropagation()
    }

    // Up/Down arrow keys to navigate between files (only when editor not focused)
    this.arrowHandler = (e: KeyboardEvent) => {
      if (!this.modal.classList.contains('visible')) return
      if (this.navigationFiles.length === 0) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return

      // Don't navigate if typing in a textarea/input
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return

      // Don't navigate if editor is focused - let CodeMirror handle cursor movement
      if (this.textEditor.hasEditorFocus()) return

      e.preventDefault()
      e.stopImmediatePropagation()

      const direction = e.key === 'ArrowUp' ? -1 : 1
      const newIndex = this.navigationIndex + direction

      // Wrap around
      if (newIndex < 0) {
        this.navigateToFile(this.navigationFiles.length - 1)
      } else if (newIndex >= this.navigationFiles.length) {
        this.navigateToFile(0)
      } else {
        this.navigateToFile(newIndex)
      }
    }

    document.addEventListener('keydown', this.escapeHandler)
    document.addEventListener('keydown', this.arrowHandler)
  }

  private detachDocumentHandlers(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
      this.escapeHandler = null
    }
    if (this.arrowHandler) {
      document.removeEventListener('keydown', this.arrowHandler)
      this.arrowHandler = null
    }
  }

  private beginShowRequest(): { requestId: number; signal: AbortSignal } {
    // Cancel older in-flight request so stale responses cannot mutate this modal.
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

  private scheduleDeferredUiTask(task: () => void, delayMs: number): number {
    const timerId = window.setTimeout(() => {
      this.deferredUiTimers.delete(timerId)
      task()
    }, delayMs)
    this.deferredUiTimers.add(timerId)
    return timerId
  }

  private clearDeferredUiTasks(): void {
    for (const timerId of this.deferredUiTimers) {
      window.clearTimeout(timerId)
    }
    this.deferredUiTimers.clear()
  }

  private navigateToFile(index: number): void {
    if (index < 0 || index >= this.navigationFiles.length) return
    if (this.textEditor.getIsDirty()) {
      if (!confirm('You have unsaved changes. Discard them?')) {
        return
      }
    }

    this.navigationIndex = index
    const filePath = this.navigationFiles[index]
    // Skip editor focus when navigating via arrow keys (prevents vim mode activation)
    this.skipEditorFocus = true
    // Show the new file, preserving navigation context
    this.show(filePath, this.currentOriginId, this.sourceWorkerId || undefined, {
      files: this.navigationFiles,
      index: this.navigationIndex,
    })
  }

  private setupVimCommands(): void {
    // Register :w command
    Vim.defineEx('write', 'w', () => {
      this.textEditor.save()
    })

    // Register :q command (with optional ! for force quit)
    Vim.defineEx('quit', 'q', (_cm: unknown, params: { argString?: string }) => {
      if (params.argString === '!') {
        this.hide()
      } else {
        this.tryClose()
      }
    })

    // Register :wq command
    Vim.defineEx('wq', 'wq', async () => {
      await this.textEditor.save()
      this.hide()
    })
  }

  /**
   * Set callback for getting workers in a city
   */
  setOnGetWorkers(fn: (originId: string, path: string) => Promise<WorkerInfo[]>): void {
    this.annotations.setOnGetWorkers(fn)
  }

  async show(
    filePath: string,
    originId: string,
    sourceWorkerId?: string,
    navigationContext?: { files: string[]; index: number },
    cityPath?: string,
    cityId?: string,
    jumpToLine?: number,
  ): Promise<void> {
    const { requestId, signal } = this.beginShowRequest()
    this.markdownView.reset()
    this.clearDeferredUiTasks()

    try {
    // Show loading state
    this.pathEl.textContent = filePath
    this.pathEl.classList.remove('dirty')
    this.langEl.textContent = 'loading...'
    this.contentEl.innerHTML = '<pre><code>Loading...</code></pre>'
    this.modeLineEl.textContent = ''
    this.saveBtn.style.display = 'none'
    this.sendBtn.style.display = 'none'
    this.fiberBtn.style.display = 'none'
    this.textEditor.reset()
    this.currentPath = filePath
    this.currentOriginId = originId
    this.currentCityPath = cityPath || ''
    this.currentCityId = cityId || ''
    this.sourceWorkerId = sourceWorkerId || null

    // Set navigation context for Up/Down arrow navigation
    if (navigationContext) {
      this.navigationFiles = navigationContext.files
      this.navigationIndex = navigationContext.index
    } else {
      this.navigationFiles = []
      this.navigationIndex = -1
      this.skipEditorFocus = false // Reset when opening fresh (not navigating)
    }

    // Reset double-Escape tracking
    this.lastEscapeTime = 0

    // Reset annotation panel
    this.annotations.reset()

    // Hide selection toolbar
    this.annotations.hideSelectionToolbar()

    // Show modal
    this.backdrop.classList.add('visible')
    this.modal.classList.add('visible')

    // Attach document-level handlers (detached in hide() to prevent HMR stacking)
    this.attachDocumentHandlers()

    // Check if this is an image file
    const ext = this.getExtension(filePath)
    if (IMAGE_EXTENSIONS.has(ext)) {
      await this.showImage(filePath, originId, requestId, signal)
      return
    }

    // Check if this is a PDF file
    if (PDF_EXTENSIONS.has(ext)) {
      await this.showPdf(filePath, originId, requestId, signal)
      return
    }

    try {
      // Fetch file content and annotations in parallel
      const [contentResponse, annotationsResponse] = await Promise.all([
        fetch(
          `${API_BASE}/file-content?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}`,
          { signal }
        ),
        fetch(
          `${API_BASE}/annotations?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}`,
          { signal }
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

      // Load annotations
      if (annotationsResponse.ok) {
        const annotationsData = await annotationsResponse.json()
        if (!this.isShowRequestActive(requestId)) return
        this.annotations.setAnnotations(annotationsData.annotations || [])
      } else {
        this.annotations.setAnnotations([])
      }

      // Update UI
      this.pathEl.textContent = data.path
      this.langEl.textContent = data.language
      this.saveBtn.style.display = 'inline-block'
      this.copyBtn.style.display = 'inline-block'
      this.downloadBtn.style.display = 'inline-block'

      // Markdown files: render by default, double-click to edit
      const isMarkdown = data.language === 'markdown' || /\.(md|markdown)$/i.test(filePath)
      if (isMarkdown) {
        this.markdownView.show(data.content)
      } else {
        this.textEditor.showEditor(jumpToLine, !this.skipEditorFocus)
      }
      this.skipEditorFocus = false
    } catch (error: any) {
      if (error?.name === 'AbortError' || !this.isShowRequestActive(requestId)) {
        return
      }
      this.langEl.textContent = 'error'
      this.contentEl.innerHTML = `<pre><code class="error">Error: ${error.message}</code></pre>`
    }
    } finally {
      this.finishShowRequest(requestId)
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
        { signal }
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

  private async showImage(filePath: string, originId: string, requestId: number, signal: AbortSignal): Promise<void> {
    this.langEl.textContent = 'image'
    this.modeLineEl.textContent = 'Click to annotate'
    this.saveBtn.style.display = 'none'
    this.copyBtn.style.display = 'none'
    this.downloadBtn.style.display = 'none'
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
      this.langEl.textContent = 'error'
      this.contentEl.innerHTML = `<pre><code class="error">Error: ${error.message}</code></pre>`
    }
  }

  private async showPdf(filePath: string, originId: string, requestId: number, signal: AbortSignal): Promise<void> {
    this.langEl.textContent = 'pdf'
    this.modeLineEl.textContent = ''
    this.saveBtn.style.display = 'none'
    this.copyBtn.style.display = 'none'
    this.downloadBtn.style.display = 'none'
    this.textEditor.setCurrentContent(null)

    if (signal.aborted || !this.isShowRequestActive(requestId)) return

    const container = document.createElement('div')
    container.className = 'file-viewer-pdf'
    container.innerHTML = `<iframe src="${this.buildRawFileUrl(filePath, originId)}" title="${escapeHtml(filePath)}" />`
    this.contentEl.innerHTML = ''
    this.contentEl.appendChild(container)
  }

  private async refresh(): Promise<void> {
    const currentContent = this.textEditor.getCurrentContent()
    if (!currentContent) return

    if (this.textEditor.getIsDirty()) {
      if (!confirm('You have unsaved changes. Refresh anyway?')) {
        return
      }
    }

    // Show feedback
    const originalText = this.refreshBtn.textContent
    this.refreshBtn.textContent = '...'

    await this.show(currentContent.path, this.currentOriginId, this.sourceWorkerId || undefined)

    this.refreshBtn.textContent = originalText
  }

  private tryClose(): void {
    if (this.textEditor.getIsDirty()) {
      if (!confirm('You have unsaved changes. Discard them?')) {
        return
      }
    }
    this.hide()
  }

  hide(): void {
    this.cancelActiveShowRequest()
    this.markdownView.reset()
    this.clearDeferredUiTasks()
    this.annotations.dispose()
    this.textEditor.reset()
    this.backdrop.classList.remove('visible')
    this.modal.classList.remove('visible')
    this.sourceWorkerId = null

    // Detach document-level handlers to prevent HMR stacking
    this.detachDocumentHandlers()
  }

  isVisible(): boolean {
    return this.modal.classList.contains('visible')
  }

  getRuntimeStats(): {
    visible: boolean
    currentPath: string | null
    currentOriginId: string
    hasEditorView: boolean
    isDirty: boolean
    markdownRendered: boolean
    annotationCount: number
    navigationFileCount: number
    navigationIndex: number
    activeShowRequestId: number
    hasActiveShowRequest: boolean
    renderedMarkdownRequestId: number
    hasRenderedMarkdownRequest: boolean
    deferredUiTimerCount: number
    hasImageAnnotationOutsideClickHandler: boolean
    hasImageAnnotationOutsideClickTimer: boolean
  } {
    const annotationStats = this.annotations.getRuntimeStats()
    return {
      visible: this.isVisible(),
      currentPath: this.currentPath || null,
      currentOriginId: this.currentOriginId,
      hasEditorView: this.textEditor.hasEditorView(),
      isDirty: this.textEditor.getIsDirty(),
      markdownRendered: this.markdownView.isActive(),
      annotationCount: annotationStats.annotationCount,
      navigationFileCount: this.navigationFiles.length,
      navigationIndex: this.navigationIndex,
      activeShowRequestId: this.activeShowRequestId,
      hasActiveShowRequest: this.activeShowAbortController !== null,
      renderedMarkdownRequestId: this.markdownView.getRuntimeStats().renderedMarkdownRequestId,
      hasRenderedMarkdownRequest: this.markdownView.getRuntimeStats().hasRenderedMarkdownRequest,
      deferredUiTimerCount: this.deferredUiTimers.size,
      hasImageAnnotationOutsideClickHandler: annotationStats.hasImageAnnotationOutsideClickHandler,
      hasImageAnnotationOutsideClickTimer: annotationStats.hasImageAnnotationOutsideClickTimer,
    }
  }

  dispose(): void {
    this.hide()
    this.markdownView.reset()
    this.clearDeferredUiTasks()
    this.annotations.dispose()
    this.textEditor.destroy()
    this.backdrop.remove()
    this.modal.remove()
  }

}
