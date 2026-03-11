import { type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { saveTextAnnotation } from './FileViewerAnnotationActions'
import type { Annotation } from './FileViewerAnnotationTypes'

interface FileViewerTextAnnotationState {
  currentPath: string
  currentOriginId: string
  originalContent: string
  editorView: EditorView | null
  isVisible: boolean
}

interface FileViewerTextAnnotationHost {
  modalEl: HTMLElement
  getState: () => FileViewerTextAnnotationState
  addAnnotation: (annotation: Annotation) => void
}

export class FileViewerTextAnnotations {
  private host: FileViewerTextAnnotationHost
  private selectionToolbar: HTMLElement | null = null

  constructor(host: FileViewerTextAnnotationHost) {
    this.host = host
  }

  reset(): void {
    this.hideSelectionToolbar()
  }

  hasSelectionToolbar(): boolean {
    return this.selectionToolbar !== null
  }

  handleEditorSelection(state: EditorState): void {
    const selection = state.selection.main
    if (selection.empty) {
      this.hideSelectionToolbar()
      return
    }

    const selectedText = state.doc.sliceString(selection.from, selection.to)
    if (selectedText.trim().length === 0) {
      this.hideSelectionToolbar()
      return
    }

    const editorView = this.host.getState().editorView
    if (!editorView) return
    const coords = editorView.coordsAtPos(selection.from)
    if (!coords) return

    this.showSelectionToolbar({
      from: selection.from,
      to: selection.to,
      selectedText,
      left: coords.left,
      top: coords.top,
    })
  }

  handleRenderedSelection(sel: Selection): void {
    const selectedText = sel.toString().trim()
    const { originalContent } = this.host.getState()
    if (!selectedText || !originalContent) return

    const exactIndex = originalContent.indexOf(selectedText)
    if (exactIndex !== -1) {
      this.showSelectionToolbarForRange(sel, exactIndex, exactIndex + selectedText.length, selectedText)
      return
    }

    const { from, to } = findSelectedRangeInContent(originalContent, selectedText)
    this.showSelectionToolbarForRange(sel, from, to, selectedText)
  }

  hideSelectionToolbar(): void {
    if (!this.selectionToolbar) return
    this.selectionToolbar.remove()
    this.selectionToolbar = null
  }

  dispose(): void {
    this.hideSelectionToolbar()
  }

  private showSelectionToolbarForRange(sel: Selection, from: number, to: number, selectedText: string): void {
    const range = sel.getRangeAt(0)
    this.showSelectionToolbar({
      from,
      to,
      selectedText,
      left: range.getBoundingClientRect().left,
      top: range.getBoundingClientRect().top,
    })
  }

  private showSelectionToolbar(args: {
    from: number
    to: number
    selectedText: string
    left: number
    top: number
  }): void {
    this.hideSelectionToolbar()

    const toolbar = document.createElement('div')
    toolbar.className = 'selection-toolbar'
    toolbar.innerHTML = `
      <button class="selection-toolbar-btn" data-action="comment" title="Add comment">
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
        </svg>
        Comment
      </button>
      <button class="selection-toolbar-btn" data-action="delete" title="Mark for deletion">
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 12h12" />
        </svg>
        Delete
      </button>
      <button class="selection-toolbar-btn selection-toolbar-close" title="Cancel">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    `

    const modalRect = this.host.modalEl.getBoundingClientRect()
    toolbar.style.position = 'absolute'
    toolbar.style.left = `${args.left - modalRect.left}px`
    toolbar.style.top = `${args.top - modalRect.top - 40}px`

    toolbar.querySelector('[data-action="comment"]')?.addEventListener('click', () => {
      this.startAnnotationInput(args.from, args.to, args.selectedText)
    })
    toolbar.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      void this.saveAnnotation(args.from, args.to, args.selectedText, '[DELETE]')
      this.hideSelectionToolbar()
    })
    toolbar.querySelector('.selection-toolbar-close')?.addEventListener('click', () => {
      this.hideSelectionToolbar()
    })

    this.selectionToolbar = toolbar
    this.host.modalEl.appendChild(toolbar)
  }

  private startAnnotationInput(from: number, to: number, selectedText: string): void {
    if (!this.selectionToolbar) return

    this.selectionToolbar.innerHTML = `
      <textarea class="annotation-input" placeholder="Add a comment..." rows="2"></textarea>
      <div class="annotation-input-actions">
        <button class="annotation-save-btn">Save</button>
        <button class="annotation-cancel-btn">Cancel</button>
      </div>
    `

    const textarea = this.selectionToolbar.querySelector('.annotation-input') as HTMLTextAreaElement | null
    const saveBtn = this.selectionToolbar.querySelector('.annotation-save-btn')
    const cancelBtn = this.selectionToolbar.querySelector('.annotation-cancel-btn')

    window.setTimeout(() => textarea?.focus(), 0)

    const save = async () => {
      const comment = textarea?.value.trim() || ''
      if (!comment) return
      await this.saveAnnotation(from, to, selectedText, comment)
      this.hideSelectionToolbar()
    }

    saveBtn?.addEventListener('click', () => {
      void save()
    })
    cancelBtn?.addEventListener('click', () => this.hideSelectionToolbar())
    textarea?.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void save()
      } else if (event.key === 'Escape') {
        this.hideSelectionToolbar()
      }
    })
  }

  private async saveAnnotation(from: number, to: number, selectedText: string, comment: string): Promise<void> {
    const { currentPath, currentOriginId, editorView, originalContent, isVisible } = this.host.getState()
    if (!currentPath) return

    const content = editorView?.state.doc.toString() || originalContent
    const contextBefore = content.slice(Math.max(0, from - 20), from)
    const contextAfter = content.slice(to, Math.min(content.length, to + 20))

    let line: number
    let endLine: number
    if (editorView) {
      line = editorView.state.doc.lineAt(from).number
      endLine = editorView.state.doc.lineAt(to).number
    } else {
      line = (content.slice(0, from).match(/\n/g) || []).length + 1
      endLine = (content.slice(0, to).match(/\n/g) || []).length + 1
    }

    try {
      const annotation = await saveTextAnnotation({
        currentPath,
        currentOriginId,
        from,
        to,
        line,
        endLine,
        selectedText,
        comment,
        contextBefore,
        contextAfter,
      })
      const state = this.host.getState()
      if (!isVisible || state.currentPath !== currentPath || state.currentOriginId !== currentOriginId) return
      this.host.addAnnotation(annotation)
    } catch (error: any) {
      console.error('Failed to save annotation:', error)
      alert(`Failed to save annotation: ${error.message}`)
    }
  }
}

function findSelectedRangeInContent(
  originalContent: string,
  selectedText: string,
): { from: number; to: number } {
  const normalize = (value: string) => value.replace(/\s+/g, '\x00')
  const normalizedSelected = normalize(selectedText)
  const normalizedOriginal = normalize(originalContent)
  const fuzzyIndex = normalizedOriginal.indexOf(normalizedSelected)
  if (fuzzyIndex === -1) {
    return { from: 0, to: 0 }
  }

  let rawFrom = 0
  let consumed = 0
  while (consumed < fuzzyIndex && rawFrom < originalContent.length) {
    if (/\s/.test(originalContent[rawFrom]) && normalizedOriginal[consumed] === '\x00') {
      while (rawFrom < originalContent.length && /\s/.test(originalContent[rawFrom])) rawFrom += 1
      consumed += 1
      continue
    }
    rawFrom += 1
    consumed += 1
  }

  const from = rawFrom
  let matchConsumed = 0
  while (matchConsumed < normalizedSelected.length && rawFrom < originalContent.length) {
    if (/\s/.test(originalContent[rawFrom]) && normalizedSelected[matchConsumed] === '\x00') {
      while (rawFrom < originalContent.length && /\s/.test(originalContent[rawFrom])) rawFrom += 1
      matchConsumed += 1
      continue
    }
    rawFrom += 1
    matchConsumed += 1
  }

  return { from, to: rawFrom }
}
