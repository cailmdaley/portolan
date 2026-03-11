import { Vim } from '@replit/codemirror-vim'
import { AnnotationPanel } from './AnnotationPanel'
import { type WorkerInfo } from './WorkerPicker'
import {
  FileViewerAnnotations,
} from './FileViewerAnnotations'
import { FileViewerContentPresenter } from './FileViewerContentPresenter'
import { FileViewerMarkdownView } from './FileViewerMarkdownView'
import { FileViewerTextEditor } from './FileViewerTextEditor'

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
  private contentPresenter: FileViewerContentPresenter
  private textEditor: FileViewerTextEditor
  private modeLineEl: HTMLElement

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
        currentPath: this.contentPresenter.getCurrentPath(),
        currentOriginId: this.contentPresenter.getCurrentOriginId(),
        currentCityPath: this.contentPresenter.getCurrentCityPath(),
        sourceWorkerId: this.contentPresenter.getSourceWorkerId(),
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
      getOriginId: () => this.contentPresenter.getCurrentOriginId(),
      isVisible: () => this.isVisible(),
      onRenderMarkdown: (content) => this.markdownView.show(content),
    })
    this.markdownView = new FileViewerMarkdownView({
      contentEl: this.contentEl,
      modeLineEl: this.modeLineEl,
      annotations: this.annotations,
      getState: () => ({
        currentPath: this.contentPresenter.getCurrentPath(),
        currentOriginId: this.contentPresenter.getCurrentOriginId(),
        currentCityPath: this.contentPresenter.getCurrentCityPath(),
        currentCityId: this.contentPresenter.getCurrentCityId(),
        isVisible: this.isVisible(),
      }),
      onOpenPath: (path, originId, cityPath, cityId, line) => {
        this.show(path, originId, undefined, undefined, cityPath, cityId, line)
      },
      onEnterEditMode: () => this.textEditor.enterMarkdownEditMode(),
    })
    this.contentPresenter = new FileViewerContentPresenter({
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
      if (
        this.textEditor.hasEditorFocus() &&
        !this.markdownView.isActive() &&
        this.textEditor.isMarkdownFile(this.contentPresenter.getCurrentPath())
      ) {
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
    // Show the new file, preserving navigation context
    this.skipEditorFocus = true
    this.show(filePath, this.contentPresenter.getCurrentOriginId(), this.contentPresenter.getSourceWorkerId() || undefined, {
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
    this.clearDeferredUiTasks()
    this.sendBtn.style.display = 'none'
    this.fiberBtn.style.display = 'none'
    if (navigationContext) {
      this.navigationFiles = navigationContext.files
      this.navigationIndex = navigationContext.index
    } else {
      this.navigationFiles = []
      this.navigationIndex = -1
      this.skipEditorFocus = false
    }
    this.lastEscapeTime = 0
    this.backdrop.classList.add('visible')
    this.modal.classList.add('visible')
    this.attachDocumentHandlers()
    await this.contentPresenter.show({
      filePath,
      originId,
      sourceWorkerId,
      cityPath,
      cityId,
      jumpToLine,
      focusEditor: !this.skipEditorFocus,
    })
    this.skipEditorFocus = false
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

    await this.show(
      currentContent.path,
      this.contentPresenter.getCurrentOriginId(),
      this.contentPresenter.getSourceWorkerId() || undefined,
    )

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
    this.clearDeferredUiTasks()
    this.contentPresenter.hide()
    this.annotations.dispose()
    this.backdrop.classList.remove('visible')
    this.modal.classList.remove('visible')

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
    const presenterStats = this.contentPresenter.getRuntimeStats()
    const markdownStats = this.markdownView.getRuntimeStats()
    return {
      visible: this.isVisible(),
      currentPath: presenterStats.currentPath,
      currentOriginId: presenterStats.currentOriginId,
      hasEditorView: this.textEditor.hasEditorView(),
      isDirty: this.textEditor.getIsDirty(),
      markdownRendered: this.markdownView.isActive(),
      annotationCount: annotationStats.annotationCount,
      navigationFileCount: this.navigationFiles.length,
      navigationIndex: this.navigationIndex,
      activeShowRequestId: presenterStats.activeShowRequestId,
      hasActiveShowRequest: presenterStats.hasActiveShowRequest,
      renderedMarkdownRequestId: markdownStats.renderedMarkdownRequestId,
      hasRenderedMarkdownRequest: markdownStats.hasRenderedMarkdownRequest,
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
