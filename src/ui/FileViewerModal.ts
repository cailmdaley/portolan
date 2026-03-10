// FileViewerModal.ts - Centered modal for viewing/editing files with CodeMirror + vim
// Extended with annotation support: selection toolbar, highlights, annotations panel
// CodeMirror imports
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html as htmlLang } from '@codemirror/lang-html'
import { vim, Vim } from '@replit/codemirror-vim'
import { escapeHtml } from './utils'
import { AnnotationPanel } from './AnnotationPanel'
import { type WorkerInfo } from './WorkerPicker'
import {
  type Annotation,
  FileViewerAnnotations,
  fileViewerAnnotationHighlightField,
} from './FileViewerAnnotations'
import { FileViewerMarkdownView } from './FileViewerMarkdownView'

declare const Prism: {
  highlight: (code: string, grammar: unknown, language: string) => string
  languages: Record<string, unknown>
  highlightElement: (el: Element) => void
}

interface FileContent {
  content: string
  language: string
  path: string
  type?: 'text' | 'image'
  url?: string  // For images
}

// Image file extensions
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'])

// PDF extension
const PDF_EXTENSIONS = new Set(['.pdf'])

const API_BASE = `http://${window.location.hostname}:4004`

// Porch Morning theme for CodeMirror
const porchMorningTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    backgroundColor: 'var(--bg-elevated)',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    caretColor: 'var(--text-primary)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--text-primary)',
    borderLeftWidth: '2px',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(154, 123, 53, 0.08)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(154, 123, 53, 0.08)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(90, 123, 123, 0.25) !important',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-card)',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--text-muted)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px',
  },
  // Vim cursor styles
  '.cm-fat-cursor': {
    backgroundColor: 'rgba(154, 123, 53, 0.7) !important',
    color: 'white !important',
  },
  '&:not(.cm-focused) .cm-fat-cursor': {
    backgroundColor: 'transparent !important',
    outline: '1px solid var(--gold)',
  },
  // Vim command line
  '.cm-vim-panel': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    padding: '4px 8px',
    backgroundColor: 'var(--bg-card)',
    borderTop: '1px solid var(--text-muted)',
  },
  '.cm-vim-panel input': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    backgroundColor: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--text-primary)',
  },
  // Annotation highlights
  '.cm-annotation-highlight': {
    backgroundColor: 'rgba(154, 123, 53, 0.2)',
    borderBottom: '2px solid var(--gold)',
    cursor: 'pointer',
  },
}, { dark: false })

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
  private modeLineEl: HTMLElement
  private currentContent: FileContent | null = null
  private currentPath: string = ''
  private currentOriginId: string = 'local'
  private currentCityPath: string = ''
  private currentCityId: string = ''
  private editorView: EditorView | null = null
  private isDirty: boolean = false
  private originalContent: string = ''
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
        originalContent: this.originalContent,
        editorView: this.editorView,
        isVisible: this.isVisible(),
      }),
      scheduleDeferredUiTask: (task, delayMs) => this.scheduleDeferredUiTask(task, delayMs),
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
      onEnterEditMode: () => this.enterFileEditMode(),
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
    this.copyBtn.addEventListener('click', () => this.copyToClipboard())

    // Download button
    this.downloadBtn.addEventListener('click', () => this.downloadFile())

    // Refresh button
    this.refreshBtn.addEventListener('click', () => this.refresh())

    // Save button
    this.saveBtn.addEventListener('click', () => this.saveFile())

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
      if (this.editorView?.hasFocus && !this.markdownView.isActive() && this.isMarkdownFile()) {
        if (now - this.lastEscapeTime < 1000) {
          // Save if dirty, then exit to rendered view
          if (this.isDirty) {
            this.saveFile().then(() => this.exitFileEditMode())
          } else {
            this.exitFileEditMode()
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
      if (this.editorView?.hasFocus) {
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
      if (this.editorView?.hasFocus) return

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
    if (this.isDirty) {
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
      this.saveFile()
    })

    // Register :q command (with optional ! for force quit)
    Vim.defineEx('quit', 'q', (_cm: unknown, params: { argString?: string }) => {
      if (params.argString === '!') {
        // :q! - force quit without saving
        this.isDirty = false
        this.hide()
      } else {
        // :q - quit with dirty check
        this.tryClose()
      }
    })

    // Register :wq command
    Vim.defineEx('wq', 'wq', async () => {
      await this.saveFile()
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
    this.isDirty = false
    this.originalContent = ''
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

    // Destroy any existing editor
    if (this.editorView) {
      this.editorView.destroy()
      this.editorView = null
    }

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
      this.currentContent = data
      this.originalContent = data.content

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
        // Create CodeMirror editor
        this.createEditor(data.content, data.language)
        // Scroll to line if requested (e.g. from search results)
        if (jumpToLine && jumpToLine > 0) {
          this.scrollToLine(jumpToLine)
        }
      }
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
    this.currentContent = null  // Can't copy image to clipboard as text

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
    this.currentContent = null  // Can't copy PDF to clipboard as text

    if (signal.aborted || !this.isShowRequestActive(requestId)) return

    const container = document.createElement('div')
    container.className = 'file-viewer-pdf'
    container.innerHTML = `<iframe src="${this.buildRawFileUrl(filePath, originId)}" title="${escapeHtml(filePath)}" />`
    this.contentEl.innerHTML = ''
    this.contentEl.appendChild(container)
  }

  private createEditor(content: string, language: string): void {
    // Clear content area
    this.contentEl.innerHTML = ''

    // Get language extension
    const langExtension = this.getLanguageExtension(language)

    // Build extensions
    const extensions: Extension[] = [
      vim(),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      autocompletion(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
      ]),
      porchMorningTheme,
      fileViewerAnnotationHighlightField,
      // Track changes for dirty state and selection
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString()
          const wasDirty = this.isDirty
          this.isDirty = newContent !== this.originalContent
          if (wasDirty !== this.isDirty) {
            this.updateDirtyIndicator()
          }
        }
        // Update mode line with cursor position
        this.updateModeLine(update.state)

        // Handle selection changes for toolbar
        if (update.selectionSet) {
          this.annotations.handleEditorSelection(update.state)
        }
      }),
    ]

    if (langExtension) {
      extensions.push(langExtension)
    }

    // Create editor state
    const state = EditorState.create({
      doc: content,
      extensions,
    })

    // Create editor view
    this.editorView = new EditorView({
      state,
      parent: this.contentEl,
    })

    // Apply annotation highlights
    this.annotations.updateAnnotationHighlights()

    // Update mode line
    this.updateModeLine(state)

    // Focus the editor (unless navigating via arrow keys)
    if (!this.skipEditorFocus) {
      this.editorView.focus()
    }
    this.skipEditorFocus = false // Reset flag
  }

  private getLanguageExtension(language: string): Extension | null {
    switch (language) {
      case 'javascript':
      case 'jsx':
        return javascript({ jsx: true })
      case 'typescript':
      case 'tsx':
        return javascript({ jsx: true, typescript: true })
      case 'python':
        return python()
      case 'markdown':
        return markdown()
      case 'json':
        return json()
      case 'css':
      case 'scss':
        return css()
      case 'html':
      case 'xml':
        return htmlLang()
      default:
        return null
    }
  }

  private isMarkdownFile(): boolean {
    if (!this.currentContent) return false
    return this.currentContent.language === 'markdown' || /\.(md|markdown)$/i.test(this.currentPath)
  }

  private enterFileEditMode(): void {
    if (!this.currentContent) return
    this.createEditor(this.currentContent.content, this.currentContent.language)
    this.modeLineEl.textContent = ''
    if (this.editorView) this.editorView.focus()
  }

  private exitFileEditMode(): void {
    if (!this.currentContent) return
    // Get current editor content (may have been edited)
    const content = this.editorView?.state.doc.toString() || this.currentContent.content
    // Update stored content
    this.currentContent.content = content
    this.originalContent = content
    this.isDirty = false
    this.updateDirtyIndicator()
    // Destroy editor and show rendered markdown
    if (this.editorView) {
      this.editorView.destroy()
      this.editorView = null
    }
    this.markdownView.show(content)
  }

  private scrollToLine(lineNumber: number): void {
    if (!this.editorView) return
    const doc = this.editorView.state.doc
    const line = doc.line(Math.min(lineNumber, doc.lines))
    this.editorView.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
  }

  private updateModeLine(state: EditorState): void {
    const pos = state.selection.main.head
    const line = state.doc.lineAt(pos)
    const col = pos - line.from + 1
    this.modeLineEl.textContent = `Ln ${line.number}, Col ${col}`
  }

  private updateDirtyIndicator(): void {
    if (this.isDirty) {
      this.pathEl.classList.add('dirty')
    } else {
      this.pathEl.classList.remove('dirty')
    }
  }

  private async saveFile(): Promise<void> {
    if (!this.editorView || !this.currentContent) return

    const content = this.editorView.state.doc.toString()

    try {
      this.saveBtn.textContent = 'Saving...'
      this.saveBtn.setAttribute('disabled', 'true')

      const response = await fetch(`${API_BASE}/save-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: this.currentContent.path,
          content,
          originId: this.currentOriginId,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save file')
      }

      // Update original content and clear dirty state
      this.originalContent = content
      this.isDirty = false
      this.updateDirtyIndicator()

      this.saveBtn.textContent = 'Saved!'
      this.scheduleDeferredUiTask(() => {
        if (!this.modal.classList.contains('visible')) return
        this.saveBtn.textContent = 'Save'
        this.saveBtn.removeAttribute('disabled')
      }, 1500)
    } catch (error: any) {
      console.error('Failed to save file:', error)
      this.saveBtn.textContent = 'Save'
      this.saveBtn.removeAttribute('disabled')
      alert(`Failed to save: ${error.message}`)
    }
  }

  private getTextContent(): string | null {
    if (this.editorView) {
      return this.editorView.state.doc.toString()
    }
    if (this.currentContent) {
      return this.currentContent.content
    }
    return null
  }

  private async copyToClipboard(): Promise<void> {
    const content = this.getTextContent()
    if (!content) return

    try {
      await navigator.clipboard.writeText(content)
      const originalText = this.copyBtn.textContent
      this.copyBtn.textContent = 'Copied!'
      this.scheduleDeferredUiTask(() => {
        if (!this.modal.classList.contains('visible')) return
        this.copyBtn.textContent = originalText
      }, 1500)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = content
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      this.copyBtn.textContent = 'Copied!'
      this.scheduleDeferredUiTask(() => {
        if (!this.modal.classList.contains('visible')) return
        this.copyBtn.textContent = 'Copy'
      }, 1500)
    }
  }

  private downloadFile(): void {
    const content = this.getTextContent()
    if (!content) return

    // Get filename from path
    const filename = this.currentPath.split('/').pop() || 'download.txt'

    // Create blob and download link
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    // Show feedback
    const originalText = this.downloadBtn.textContent
    this.downloadBtn.textContent = 'Downloaded!'
    this.scheduleDeferredUiTask(() => {
      if (!this.modal.classList.contains('visible')) return
      this.downloadBtn.textContent = originalText
    }, 1500)
  }

  private async refresh(): Promise<void> {
    if (!this.currentContent) return

    // Check for unsaved changes
    if (this.isDirty) {
      if (!confirm('You have unsaved changes. Refresh anyway?')) {
        return
      }
    }

    // Show feedback
    const originalText = this.refreshBtn.textContent
    this.refreshBtn.textContent = '...'

    // Re-fetch the file
    await this.show(this.currentContent.path, this.currentOriginId, this.sourceWorkerId || undefined)

    this.refreshBtn.textContent = originalText
  }

  private tryClose(): void {
    if (this.isDirty) {
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
    this.backdrop.classList.remove('visible')
    this.modal.classList.remove('visible')
    this.currentContent = null
    this.isDirty = false
    this.pathEl.classList.remove('dirty')
    this.sourceWorkerId = null

    // Detach document-level handlers to prevent HMR stacking
    this.detachDocumentHandlers()

    // Destroy editor
    if (this.editorView) {
      this.editorView.destroy()
      this.editorView = null
    }
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
      hasEditorView: this.editorView !== null,
      isDirty: this.isDirty,
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
    this.backdrop.remove()
    this.modal.remove()
  }

}
