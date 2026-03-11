import { parseFiberFrontmatter, FileViewerFiberContext, isFiberMarkdownFile, renderFiberHeader } from './FileViewerFiberContext'
import { renderMarkdown, attachInlinePathListeners } from './utils'
import { type FileViewerAnnotations } from './FileViewerAnnotations'

interface MarkdownViewState {
  currentPath: string
  currentOriginId: string
  currentCityPath: string
  currentCityId: string
  isVisible: boolean
}

interface FileViewerMarkdownViewOptions {
  contentEl: HTMLElement
  modeLineEl: HTMLElement
  annotations: FileViewerAnnotations
  getState: () => MarkdownViewState
  onOpenPath: (path: string, originId: string, cityPath: string, cityId: string, line?: number) => void
  onEnterEditMode: () => void
}

export class FileViewerMarkdownView {
  private contentEl: HTMLElement
  private modeLineEl: HTMLElement
  private annotations: FileViewerAnnotations
  private getState: () => MarkdownViewState
  private onOpenPath: FileViewerMarkdownViewOptions['onOpenPath']
  private onEnterEditMode: () => void
  private fiberContext: FileViewerFiberContext
  private active = false

  constructor(options: FileViewerMarkdownViewOptions) {
    this.contentEl = options.contentEl
    this.modeLineEl = options.modeLineEl
    this.annotations = options.annotations
    this.getState = options.getState
    this.onOpenPath = options.onOpenPath
    this.onEnterEditMode = options.onEnterEditMode
    this.fiberContext = new FileViewerFiberContext({
      contentEl: this.contentEl,
      getState: () => {
        const state = this.getState()
        return {
          currentPath: state.currentPath,
          isVisible: state.isVisible,
        }
      },
    })
  }

  isActive(): boolean {
    return this.active
  }

  show(content: string): void {
    this.active = true
    this.contentEl.innerHTML = ''

    const state = this.getState()
    const dirPath = state.currentPath.replace(/\/[^/]+$/, '')
    const wrapper = document.createElement('div')
    wrapper.className = 'file-viewer-markdown editable-markdown'

    const mdOpts = {
      basePath: state.currentCityPath || dirPath,
      originId: state.currentOriginId,
    }

    const isFiber = isFiberMarkdownFile(state.currentPath)
    const { frontmatter, body } = isFiber
      ? parseFiberFrontmatter(content)
      : { frontmatter: null, body: content }

    wrapper.innerHTML = frontmatter
      ? renderFiberHeader(frontmatter) + renderMarkdown(body, mdOpts)
      : renderMarkdown(content, mdOpts)

    this.contentEl.appendChild(wrapper)

    if ((window as any).Prism) {
      (window as any).Prism.highlightAllUnder(wrapper)
    }

    attachInlinePathListeners(wrapper, (relPath, line) => {
      const fullPath = relPath.startsWith('/') ? relPath : `${state.currentCityPath || dirPath}/${relPath}`
      this.onOpenPath(fullPath, state.currentOriginId, state.currentCityPath, state.currentCityId, line)
    })

    void this.fiberContext.hydrate(wrapper, state.currentPath, state.currentCityId)

    this.modeLineEl.textContent = 'Double-click to edit'

    let dblClickPending = false
    wrapper.addEventListener('dblclick', (e) => {
      dblClickPending = true
      if ((e.target as HTMLElement).closest('a')) return
      this.active = false
      this.onEnterEditMode()
    })

    wrapper.addEventListener('mouseup', () => {
      setTimeout(() => {
        if (dblClickPending) {
          dblClickPending = false
          return
        }
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          this.annotations.hideSelectionToolbar()
          return
        }
        this.annotations.handleRenderedSelection(sel)
      }, 200)
    })
  }

  reset(): void {
    this.active = false
    this.cancel()
  }

  cancel(): void {
    this.fiberContext.cancel()
  }

  getRuntimeStats(): {
    renderedMarkdownRequestId: number
    hasRenderedMarkdownRequest: boolean
  } {
    return {
      renderedMarkdownRequestId: this.fiberContext.getRuntimeStats().requestId,
      hasRenderedMarkdownRequest: this.fiberContext.getRuntimeStats().hasRequest,
    }
  }
}
