import type { TapestryNode } from './tapestry-types'

interface TapestryViewInteractionsOptions {
  detailPanel: HTMLElement
  sidebarResizeHandle: HTMLElement | null
  sidebar: HTMLElement | null
  isVisible: () => boolean
  isStaticMode: () => boolean
  getEditingNode: () => TapestryNode | null
  exitBodyEditMode: (node: TapestryNode) => void
  hide: () => void
  hideDetail: () => void
  handleTextSelection: (selection: Selection) => void
}

export class TapestryViewInteractions {
  private options: TapestryViewInteractionsOptions
  private escapeHandler: ((event: KeyboardEvent) => void) | null = null
  private resizeMouseMoveHandler: ((event: MouseEvent) => void) | null = null
  private resizeMouseUpHandler: (() => void) | null = null
  private selectionTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(options: TapestryViewInteractionsOptions) {
    this.options = options
    this.setupEscapeHandler()
    this.setupSidebarResize()
    this.setupSelectionHandling()
  }

  attach(): void {
    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
  }

  detach(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
    }
    this.cancelSelectionTimeout()
    this.teardownResizeDrag()
  }

  destroy(): void {
    this.detach()
  }

  getRuntimeStats(): { hasEscapeHandler: boolean; hasSelectionTimeout: boolean; hasResizeDrag: boolean } {
    return {
      hasEscapeHandler: this.escapeHandler !== null,
      hasSelectionTimeout: this.selectionTimeout !== null,
      hasResizeDrag: this.resizeMouseMoveHandler !== null || this.resizeMouseUpHandler !== null,
    }
  }

  private setupEscapeHandler(): void {
    this.escapeHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !this.options.isVisible()) return
      const editingNode = this.options.getEditingNode()
      if (editingNode) {
        this.options.exitBodyEditMode(editingNode)
        return
      }
      if (this.options.detailPanel.classList.contains('hidden')) {
        this.options.hide()
      } else {
        this.options.hideDetail()
      }
    }
  }

  private setupSidebarResize(): void {
    const { sidebarResizeHandle, sidebar } = this.options
    if (!sidebarResizeHandle || !sidebar) return

    sidebarResizeHandle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      sidebar.style.transition = 'none'
      const startX = event.clientX
      const startWidth = sidebar.getBoundingClientRect().width

      this.resizeMouseMoveHandler = (moveEvent: MouseEvent) => {
        const maxWidth = window.innerWidth * 0.85
        const newWidth = Math.max(300, Math.min(maxWidth, startWidth - (moveEvent.clientX - startX)))
        sidebar.style.width = `${newWidth}px`
      }

      this.resizeMouseUpHandler = () => {
        sidebar.style.transition = ''
        this.teardownResizeDrag()
      }

      document.addEventListener('mousemove', this.resizeMouseMoveHandler)
      document.addEventListener('mouseup', this.resizeMouseUpHandler)
    })
  }

  private setupSelectionHandling(): void {
    this.options.detailPanel.addEventListener('mouseup', () => {
      if (this.options.isStaticMode()) return
      this.cancelSelectionTimeout()
      this.selectionTimeout = setTimeout(() => {
        this.selectionTimeout = null
        const selection = window.getSelection()
        if (selection && selection.toString().trim().length > 0) {
          this.options.handleTextSelection(selection)
        }
      }, 250)
    })

    this.options.detailPanel.addEventListener('dblclick', () => {
      this.cancelSelectionTimeout()
    })
  }

  private cancelSelectionTimeout(): void {
    if (this.selectionTimeout) {
      clearTimeout(this.selectionTimeout)
      this.selectionTimeout = null
    }
  }

  private teardownResizeDrag(): void {
    if (this.resizeMouseMoveHandler) {
      document.removeEventListener('mousemove', this.resizeMouseMoveHandler)
      this.resizeMouseMoveHandler = null
    }
    if (this.resizeMouseUpHandler) {
      document.removeEventListener('mouseup', this.resizeMouseUpHandler)
      this.resizeMouseUpHandler = null
    }
  }
}
