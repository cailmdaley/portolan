import { Vim } from '@replit/codemirror-vim'
import { AnnotationPanel } from './AnnotationPanel'
import { type WorkerInfo } from './WorkerPicker'
import {
  FileViewerAnnotations,
} from './FileViewerAnnotations'
import { FileViewerContentPresenter } from './FileViewerContentPresenter'
import { FileViewerMarkdownView } from './FileViewerMarkdownView'
import { FileViewerModalRuntime } from './FileViewerModalRuntime'
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
  private vellumBtn: HTMLElement
  private closeBtn: HTMLElement
  // @ts-expect-error Stored for potential future layout changes
  private contentWrapper: HTMLElement
  private contentEl: HTMLElement
  private annotationsPanelEl: HTMLElement
  private annotations: FileViewerAnnotations
  private contentPresenter: FileViewerContentPresenter
  private textEditor: FileViewerTextEditor
  private modeLineEl: HTMLElement

  private markdownView: FileViewerMarkdownView
  private runtime: FileViewerModalRuntime

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
    this.vellumBtn = this.modal.querySelector('.file-viewer-vellum')!
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
      scheduleDeferredUiTask: (task, delayMs) => this.runtime.scheduleDeferredUiTask(task, delayMs),
      onGotoSlide: (slideIndex) => this.contentPresenter.gotoSlide(slideIndex),
    })
    this.textEditor = new FileViewerTextEditor({
      contentEl: this.contentEl,
      pathEl: this.pathEl,
      modeLineEl: this.modeLineEl,
      saveBtn: this.saveBtn,
      copyBtn: this.copyBtn,
      downloadBtn: this.downloadBtn,
      annotations: this.annotations,
      scheduleDeferredUiTask: (task, delayMs) => this.runtime.scheduleDeferredUiTask(task, delayMs),
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
    this.runtime = new FileViewerModalRuntime({
      backdropEl: this.backdrop,
      modalEl: this.modal,
      annotations: this.annotations,
      textEditor: this.textEditor,
      markdownView: this.markdownView,
      contentPresenter: this.contentPresenter,
      isVisible: () => this.isVisible(),
      onCloseRequested: () => this.tryClose(),
      onNavigate: (filePath, navigationContext) => {
        void this.show(
          filePath,
          this.contentPresenter.getCurrentOriginId(),
          this.contentPresenter.getSourceWorkerId() || undefined,
          navigationContext,
        )
      },
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
          <button class="file-viewer-btn file-viewer-vellum" title="Open in vellum reader (experimental)">Vellum</button>
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

    // Vellum (experimental): open current file in the vellum reader overlay.
    // Uses the global seam installed in main.ts (`__mountVellumFileViewer`) so
    // this button is a pure host-side hop; see vellum-in-portolan step 3.
    this.vellumBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const path = this.contentPresenter.getCurrentPath()
      if (!path) return
      const mount = (window as unknown as {
        __mountVellumFileViewer?: (opts: { path: string; originId?: string; cityId?: string; editable?: boolean }) => void
      }).__mountVellumFileViewer
      if (!mount) {
        console.warn('[FileViewerModal] vellum mount seam not installed')
        return
      }
      mount({
        path,
        originId: this.contentPresenter.getCurrentOriginId(),
        cityId: this.contentPresenter.getCurrentCityId() || undefined,
        editable: true,
      })
      if (this.textEditor.getIsDirty()) {
        console.warn('[FileViewerModal] vellum opened with unsaved portolan edits; not auto-closing')
        return
      }
      this.hide()
    })

    // Document-level handlers are attached in the runtime during show()/hide().
    // This prevents HMR stacking where old listeners accumulate across hot reloads.
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
    cacheBust?: boolean,
    preserveHtmlUrl?: string,
  ): Promise<void> {
    this.runtime.activate(navigationContext)
    this.sendBtn.style.display = 'none'
    this.fiberBtn.style.display = 'none'
    await this.contentPresenter.show({
      filePath,
      originId,
      sourceWorkerId,
      cityPath,
      cityId,
      jumpToLine,
      focusEditor: this.runtime.shouldFocusEditor(),
      cacheBust,
      preserveHtmlUrl,
    })
    this.runtime.completeShow()
  }

  private async refresh(): Promise<void> {
    const currentPath = this.contentPresenter.getCurrentPath()
    if (!currentPath) return

    if (this.textEditor.getIsDirty()) {
      if (!confirm('You have unsaved changes. Refresh anyway?')) {
        return
      }
    }

    // Show feedback
    const originalText = this.refreshBtn.textContent
    this.refreshBtn.textContent = '...'
    const preserveHtmlUrl = this.contentPresenter.getCurrentHtmlViewUrl() || undefined

    try {
      await this.show(
        currentPath,
        this.contentPresenter.getCurrentOriginId(),
        this.contentPresenter.getSourceWorkerId() || undefined,
        undefined,
        this.contentPresenter.getCurrentCityPath() || undefined,
        this.contentPresenter.getCurrentCityId() || undefined,
        undefined,
        true,
        preserveHtmlUrl,
      )
    } finally {
      this.refreshBtn.textContent = originalText
    }
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
    this.contentPresenter.hide()
    this.annotations.dispose()
    this.runtime.deactivate()
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
    const runtimeStats = this.runtime.getRuntimeStats()
    return {
      visible: this.isVisible(),
      currentPath: presenterStats.currentPath,
      currentOriginId: presenterStats.currentOriginId,
      hasEditorView: this.textEditor.hasEditorView(),
      isDirty: this.textEditor.getIsDirty(),
      markdownRendered: this.markdownView.isActive(),
      annotationCount: annotationStats.annotationCount,
      navigationFileCount: runtimeStats.navigationFileCount,
      navigationIndex: runtimeStats.navigationIndex,
      activeShowRequestId: presenterStats.activeShowRequestId,
      hasActiveShowRequest: presenterStats.hasActiveShowRequest,
      renderedMarkdownRequestId: markdownStats.renderedMarkdownRequestId,
      hasRenderedMarkdownRequest: markdownStats.hasRenderedMarkdownRequest,
      deferredUiTimerCount: runtimeStats.deferredUiTimerCount,
      hasImageAnnotationOutsideClickHandler: annotationStats.hasImageAnnotationOutsideClickHandler,
      hasImageAnnotationOutsideClickTimer: annotationStats.hasImageAnnotationOutsideClickTimer,
    }
  }

  dispose(): void {
    this.hide()
    this.markdownView.reset()
    this.annotations.dispose()
    this.textEditor.destroy()
    this.contentPresenter.dispose()
    this.backdrop.remove()
    this.modal.remove()
  }

}
