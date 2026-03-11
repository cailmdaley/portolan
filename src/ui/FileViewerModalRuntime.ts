import type { FileViewerAnnotations } from './FileViewerAnnotations'
import type { FileViewerContentPresenter } from './FileViewerContentPresenter'
import type { FileViewerMarkdownView } from './FileViewerMarkdownView'
import type { FileViewerTextEditor } from './FileViewerTextEditor'

interface ShowNavigationContext {
  files: string[]
  index: number
}

interface FileViewerModalRuntimeOptions {
  backdropEl: HTMLElement
  modalEl: HTMLElement
  annotations: FileViewerAnnotations
  textEditor: FileViewerTextEditor
  markdownView: FileViewerMarkdownView
  contentPresenter: FileViewerContentPresenter
  isVisible: () => boolean
  onCloseRequested: () => void
  onNavigate: (filePath: string, navigationContext: ShowNavigationContext) => void
}

export class FileViewerModalRuntime {
  private backdropEl: HTMLElement
  private modalEl: HTMLElement
  private annotations: FileViewerAnnotations
  private textEditor: FileViewerTextEditor
  private markdownView: FileViewerMarkdownView
  private contentPresenter: FileViewerContentPresenter
  private isVisible: () => boolean
  private onCloseRequested: () => void
  private onNavigate: FileViewerModalRuntimeOptions['onNavigate']

  private navigationFiles: string[] = []
  private navigationIndex = -1
  private skipEditorFocus = false
  private lastEscapeTime = 0
  private deferredUiTimers = new Set<number>()
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private arrowHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(options: FileViewerModalRuntimeOptions) {
    this.backdropEl = options.backdropEl
    this.modalEl = options.modalEl
    this.annotations = options.annotations
    this.textEditor = options.textEditor
    this.markdownView = options.markdownView
    this.contentPresenter = options.contentPresenter
    this.isVisible = options.isVisible
    this.onCloseRequested = options.onCloseRequested
    this.onNavigate = options.onNavigate
  }

  activate(navigationContext?: ShowNavigationContext): void {
    this.clearDeferredUiTasks()
    if (navigationContext) {
      this.navigationFiles = navigationContext.files
      this.navigationIndex = navigationContext.index
    } else {
      this.navigationFiles = []
      this.navigationIndex = -1
      this.skipEditorFocus = false
    }
    this.lastEscapeTime = 0
    this.backdropEl.classList.add('visible')
    this.modalEl.classList.add('visible')
    this.attachDocumentHandlers()
  }

  completeShow(): void {
    this.skipEditorFocus = false
  }

  deactivate(): void {
    this.clearDeferredUiTasks()
    this.backdropEl.classList.remove('visible')
    this.modalEl.classList.remove('visible')
    this.detachDocumentHandlers()
  }

  shouldFocusEditor(): boolean {
    return !this.skipEditorFocus
  }

  scheduleDeferredUiTask(task: () => void, delayMs: number): number {
    const timerId = window.setTimeout(() => {
      this.deferredUiTimers.delete(timerId)
      task()
    }, delayMs)
    this.deferredUiTimers.add(timerId)
    return timerId
  }

  getRuntimeStats(): {
    navigationFileCount: number
    navigationIndex: number
    deferredUiTimerCount: number
  } {
    return {
      navigationFileCount: this.navigationFiles.length,
      navigationIndex: this.navigationIndex,
      deferredUiTimerCount: this.deferredUiTimers.size,
    }
  }

  private attachDocumentHandlers(): void {
    if (this.escapeHandler) return

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.isVisible()) return

      if (this.annotations.hasSelectionToolbar()) {
        this.annotations.hideSelectionToolbar()
        e.stopPropagation()
        return
      }

      const now = Date.now()

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
        }
        this.lastEscapeTime = now
        return
      }

      if (this.textEditor.hasEditorFocus()) {
        if (now - this.lastEscapeTime < 1000) {
          this.onCloseRequested()
          e.stopPropagation()
          this.lastEscapeTime = 0
        } else {
          this.lastEscapeTime = now
        }
        return
      }

      this.onCloseRequested()
      e.stopPropagation()
    }

    this.arrowHandler = (e: KeyboardEvent) => {
      if (!this.isVisible()) return
      if (this.navigationFiles.length === 0) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return

      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return
      if (this.textEditor.hasEditorFocus()) return

      e.preventDefault()
      e.stopImmediatePropagation()

      const direction = e.key === 'ArrowUp' ? -1 : 1
      const newIndex = this.navigationIndex + direction
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
    this.skipEditorFocus = true
    this.onNavigate(this.navigationFiles[index], {
      files: this.navigationFiles,
      index: this.navigationIndex,
    })
  }
}
