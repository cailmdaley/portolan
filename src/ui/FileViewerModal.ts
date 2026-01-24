// FileViewerModal.ts - Centered modal for viewing/editing files with CodeMirror + vim
// Extended with annotation support: selection toolbar, highlights, annotations panel

import { marked } from 'marked'
// CodeMirror imports
import { EditorState, type Extension, StateField, StateEffect } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, Decoration, type DecorationSet } from '@codemirror/view'
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

// Configure marked for GFM (tables, task lists, etc.)
marked.setOptions({
  breaks: true,
  gfm: true,
})

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

// Annotation type from server
export interface Annotation {
  id: string
  filePath: string
  originId: string
  from: number
  to: number
  line?: number  // line number at 'from' (1-indexed)
  originalText: string
  contextBefore: string
  contextAfter: string
  comment: string
  createdAt: number
}

// Worker info for send-to-worker
export interface WorkerInfo {
  id: string
  name: string
  tmuxSession: string
}

// Image file extensions
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'])

// PDF extension
const PDF_EXTENSIONS = new Set(['.pdf'])

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

// CodeMirror effect and field for annotation highlights
const setAnnotationsEffect = StateEffect.define<Annotation[]>()

const annotationMark = Decoration.mark({ class: 'cm-annotation-highlight' })

const annotationHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setAnnotationsEffect)) {
        const annotations = e.value
        const marks: { from: number; to: number }[] = []
        for (const ann of annotations) {
          // Clamp to document bounds
          const from = Math.max(0, Math.min(ann.from, tr.state.doc.length))
          const to = Math.max(from, Math.min(ann.to, tr.state.doc.length))
          if (from < to) {
            marks.push({ from, to })
          }
        }
        // Sort and create decorations
        marks.sort((a, b) => a.from - b.from)
        decorations = Decoration.set(
          marks.map(m => annotationMark.range(m.from, m.to))
        )
      }
    }
    return decorations
  },
  provide: f => EditorView.decorations.from(f),
})

export class FileViewerModal {
  private backdrop: HTMLElement
  private modal: HTMLElement
  private pathEl: HTMLElement
  private langEl: HTMLElement
  private refreshBtn: HTMLElement
  private copyBtn: HTMLElement
  private saveBtn: HTMLElement
  private sendBtn: HTMLElement
  private closeBtn: HTMLElement
  // @ts-expect-error Stored for potential future layout changes
  private contentWrapper: HTMLElement
  private contentEl: HTMLElement
  private annotationsPanel: HTMLElement
  private modeLineEl: HTMLElement
  private selectionToolbar: HTMLElement | null = null
  private currentContent: FileContent | null = null
  private currentOriginId: string = 'local'
  private editorView: EditorView | null = null
  private isDirty: boolean = false
  private originalContent: string = ''

  // Annotation state
  private annotations: Annotation[] = []
  private globalComment: string = ''
  private sourceWorkerId: string | null = null
  private cityWorkers: WorkerInfo[] = []
  private onGetWorkers: ((originId: string, path: string) => Promise<WorkerInfo[]>) | null = null

  constructor() {
    this.backdrop = this.createBackdrop()
    this.modal = this.createModal()
    this.pathEl = this.modal.querySelector('.file-viewer-path')!
    this.langEl = this.modal.querySelector('.file-viewer-lang')!
    this.refreshBtn = this.modal.querySelector('.file-viewer-refresh')!
    this.copyBtn = this.modal.querySelector('.file-viewer-copy')!
    this.saveBtn = this.modal.querySelector('.file-viewer-save')!
    this.sendBtn = this.modal.querySelector('.file-viewer-send')!
    this.closeBtn = this.modal.querySelector('.file-viewer-close')!
    this.contentWrapper = this.modal.querySelector('.file-viewer-content-wrapper')!
    this.contentEl = this.modal.querySelector('.file-viewer-content')!
    this.annotationsPanel = this.modal.querySelector('.file-viewer-annotations')!
    this.modeLineEl = this.modal.querySelector('.file-viewer-modeline')!

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
          <button class="file-viewer-btn file-viewer-send" style="display: none;">Send to Worker</button>
          <button class="file-viewer-btn file-viewer-refresh" title="Refresh file">↻</button>
          <button class="file-viewer-btn file-viewer-copy">Copy</button>
          <button class="file-viewer-close">&times;</button>
        </div>
      </div>
      <div class="file-viewer-content-wrapper">
        <div class="file-viewer-content"></div>
        <div class="file-viewer-annotations">
          <div class="annotations-header">
            <span>Annotations</span>
            <div class="annotations-header-actions">
              <button class="annotations-clear-all" title="Clear all annotations">Clear</button>
              <button class="annotations-toggle" title="Toggle panel">◀</button>
            </div>
          </div>
          <div class="annotations-list"></div>
          <div class="annotations-global-comment">
            <label>Overall feedback:</label>
            <textarea class="global-comment-textarea" placeholder="Add summary or overall context..."></textarea>
          </div>
        </div>
      </div>
      <div class="file-viewer-modeline"></div>
    `
    return modal
  }

  private setupEventListeners(): void {
    // Close on backdrop click
    this.backdrop.addEventListener('click', () => this.tryClose())

    // Close button
    this.closeBtn.addEventListener('click', () => this.tryClose())

    // Copy button
    this.copyBtn.addEventListener('click', () => this.copyToClipboard())

    // Refresh button
    this.refreshBtn.addEventListener('click', () => this.refresh())

    // Save button
    this.saveBtn.addEventListener('click', () => this.saveFile())

    // Send to worker button
    this.sendBtn.addEventListener('click', () => this.showWorkerPicker())

    // Annotations panel toggle
    const toggleBtn = this.annotationsPanel.querySelector('.annotations-toggle')
    toggleBtn?.addEventListener('click', () => {
      this.annotationsPanel.classList.toggle('collapsed')
      const btn = toggleBtn as HTMLElement
      btn.textContent = this.annotationsPanel.classList.contains('collapsed') ? '▶' : '◀'
    })

    // Clear all annotations
    const clearAllBtn = this.annotationsPanel.querySelector('.annotations-clear-all')
    clearAllBtn?.addEventListener('click', () => {
      if (this.annotations.length === 0) return
      this.clearAllAnnotations()
    })

    // Global comment textarea
    const globalCommentTextarea = this.annotationsPanel.querySelector('.global-comment-textarea') as HTMLTextAreaElement
    globalCommentTextarea?.addEventListener('input', () => {
      this.globalComment = globalCommentTextarea.value
    })

    // Escape key to close (only if not in vim insert mode)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modal.classList.contains('visible')) {
        // Hide selection toolbar first
        if (this.selectionToolbar) {
          this.hideSelectionToolbar()
          return
        }
        // Don't close if we have an editor - vim handles escape
        if (!this.editorView) {
          this.tryClose()
        }
      }
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
    this.onGetWorkers = fn
  }

  async show(
    filePath: string,
    originId: string,
    sourceWorkerId?: string
  ): Promise<void> {
    // Show loading state
    this.pathEl.textContent = filePath
    this.pathEl.classList.remove('dirty')
    this.langEl.textContent = 'loading...'
    this.contentEl.innerHTML = '<pre><code>Loading...</code></pre>'
    this.modeLineEl.textContent = ''
    this.saveBtn.style.display = 'none'
    this.sendBtn.style.display = 'none'
    this.isDirty = false
    this.originalContent = ''
    this.currentOriginId = originId
    this.sourceWorkerId = sourceWorkerId || null
    this.annotations = []
    this.globalComment = ''
    this.cityWorkers = []

    // Reset global comment textarea
    const globalCommentTextarea = this.annotationsPanel.querySelector('.global-comment-textarea') as HTMLTextAreaElement
    if (globalCommentTextarea) globalCommentTextarea.value = ''

    // Destroy any existing editor
    if (this.editorView) {
      this.editorView.destroy()
      this.editorView = null
    }

    // Hide selection toolbar
    this.hideSelectionToolbar()

    // Show modal
    this.backdrop.classList.add('visible')
    this.modal.classList.add('visible')

    // Check if this is an image file
    const ext = this.getExtension(filePath)
    if (IMAGE_EXTENSIONS.has(ext)) {
      await this.showImage(filePath, originId)
      return
    }

    // Check if this is a PDF file
    if (PDF_EXTENSIONS.has(ext)) {
      await this.showPdf(filePath, originId)
      return
    }

    try {
      // Fetch file content and annotations in parallel
      const [contentResponse, annotationsResponse] = await Promise.all([
        fetch(
          `http://${window.location.hostname}:4004/file-content?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}`
        ),
        fetch(
          `http://${window.location.hostname}:4004/annotations?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}`
        ),
      ])

      if (!contentResponse.ok) {
        const error = await contentResponse.json()
        throw new Error(error.error || 'Failed to load file')
      }

      const data: FileContent = await contentResponse.json()
      this.currentContent = data
      this.originalContent = data.content

      // Load annotations
      if (annotationsResponse.ok) {
        const annotationsData = await annotationsResponse.json()
        this.annotations = annotationsData.annotations || []
      }

      // Update UI
      this.pathEl.textContent = data.path
      this.langEl.textContent = data.language
      this.saveBtn.style.display = 'inline-block'

      // Show send button if we have annotations
      this.updateSendButton()

      // Create CodeMirror editor
      this.createEditor(data.content, data.language)

      // Render annotations panel
      this.renderAnnotationsPanel()
    } catch (error: any) {
      this.langEl.textContent = 'error'
      this.contentEl.innerHTML = `<pre><code class="error">Error: ${error.message}</code></pre>`
    }
  }

  private getExtension(filePath: string): string {
    const match = filePath.match(/\.[^.]+$/)
    return match ? match[0].toLowerCase() : ''
  }

  private async showImage(filePath: string, originId: string): Promise<void> {
    this.langEl.textContent = 'image'
    this.modeLineEl.textContent = ''
    this.saveBtn.style.display = 'none'
    this.currentContent = null  // Can't copy image to clipboard as text

    try {
      const response = await fetch(
        `http://${window.location.hostname}:4004/file-content?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}&binary=true`
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to load image')
      }

      const data = await response.json()

      if (data.type === 'image' && data.url) {
        const container = document.createElement('div')
        container.className = 'file-viewer-image'
        container.innerHTML = `<img src="${data.url}" alt="${this.escapeHtml(filePath)}" />`
        this.contentEl.innerHTML = ''
        this.contentEl.appendChild(container)
      } else {
        throw new Error('Invalid image response')
      }
    } catch (error: any) {
      this.langEl.textContent = 'error'
      this.contentEl.innerHTML = `<pre><code class="error">Error: ${error.message}</code></pre>`
    }
  }

  private async showPdf(filePath: string, originId: string): Promise<void> {
    this.langEl.textContent = 'pdf'
    this.modeLineEl.textContent = ''
    this.saveBtn.style.display = 'none'
    this.currentContent = null  // Can't copy PDF to clipboard as text

    try {
      const response = await fetch(
        `http://${window.location.hostname}:4004/file-content?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(originId)}&binary=true`
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to load PDF')
      }

      const data = await response.json()

      if (data.type === 'pdf' && data.url) {
        const container = document.createElement('div')
        container.className = 'file-viewer-pdf'
        container.innerHTML = `<iframe src="${data.url}" title="${this.escapeHtml(filePath)}" />`
        this.contentEl.innerHTML = ''
        this.contentEl.appendChild(container)
      } else {
        throw new Error('Invalid PDF response')
      }
    } catch (error: any) {
      this.langEl.textContent = 'error'
      this.contentEl.innerHTML = `<pre><code class="error">Error: ${error.message}</code></pre>`
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
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
      annotationHighlightField,
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
          this.handleSelectionChange(update.state)
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
    this.updateAnnotationHighlights()

    // Update mode line
    this.updateModeLine(state)

    // Focus the editor
    this.editorView.focus()
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

      const response = await fetch(`http://${window.location.hostname}:4004/save-file`, {
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
      setTimeout(() => {
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

  private async copyToClipboard(): Promise<void> {
    let content: string
    if (this.editorView) {
      content = this.editorView.state.doc.toString()
    } else if (this.currentContent) {
      content = this.currentContent.content
    } else {
      return
    }

    try {
      await navigator.clipboard.writeText(content)
      const originalText = this.copyBtn.textContent
      this.copyBtn.textContent = 'Copied!'
      setTimeout(() => {
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
      setTimeout(() => {
        this.copyBtn.textContent = 'Copy'
      }, 1500)
    }
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
    this.backdrop.classList.remove('visible')
    this.modal.classList.remove('visible')
    this.currentContent = null
    this.isDirty = false
    this.pathEl.classList.remove('dirty')
    this.annotations = []
    this.sourceWorkerId = null
    this.hideSelectionToolbar()

    // Destroy editor
    if (this.editorView) {
      this.editorView.destroy()
      this.editorView = null
    }
  }

  isVisible(): boolean {
    return this.modal.classList.contains('visible')
  }

  // ============================================================================
  // Selection Toolbar
  // ============================================================================

  private handleSelectionChange(state: EditorState): void {
    const selection = state.selection.main

    // Only show toolbar for non-empty selections
    if (selection.empty) {
      this.hideSelectionToolbar()
      return
    }

    // Get selected text
    const selectedText = state.doc.sliceString(selection.from, selection.to)
    if (selectedText.trim().length === 0) {
      this.hideSelectionToolbar()
      return
    }

    // Show toolbar above selection
    this.showSelectionToolbar(selection.from, selection.to, selectedText)
  }

  private showSelectionToolbar(from: number, to: number, selectedText: string): void {
    // Get position for toolbar
    if (!this.editorView) return

    const coords = this.editorView.coordsAtPos(from)
    if (!coords) return

    // Remove existing toolbar
    this.hideSelectionToolbar()

    // Create toolbar
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

    // Position toolbar above selection
    const modalRect = this.modal.getBoundingClientRect()
    toolbar.style.position = 'absolute'
    toolbar.style.left = `${coords.left - modalRect.left}px`
    toolbar.style.top = `${coords.top - modalRect.top - 40}px`

    // Event handlers
    const commentBtn = toolbar.querySelector('[data-action="comment"]')!
    commentBtn.addEventListener('click', () => {
      this.startAnnotationInput(from, to, selectedText)
    })

    const deleteBtn = toolbar.querySelector('[data-action="delete"]')!
    deleteBtn.addEventListener('click', () => {
      this.saveAnnotation(from, to, selectedText, '[DELETE]')
      this.hideSelectionToolbar()
    })

    const closeBtn = toolbar.querySelector('.selection-toolbar-close')!
    closeBtn.addEventListener('click', () => {
      this.hideSelectionToolbar()
    })

    // Store for cleanup
    this.selectionToolbar = toolbar
    this.modal.appendChild(toolbar)
  }

  private hideSelectionToolbar(): void {
    if (this.selectionToolbar) {
      this.selectionToolbar.remove()
      this.selectionToolbar = null
    }
  }

  private startAnnotationInput(from: number, to: number, selectedText: string): void {
    if (!this.selectionToolbar || !this.editorView) return

    // Replace toolbar content with input
    this.selectionToolbar.innerHTML = `
      <textarea class="annotation-input" placeholder="Add a comment..." rows="2"></textarea>
      <div class="annotation-input-actions">
        <button class="annotation-save-btn">Save</button>
        <button class="annotation-cancel-btn">Cancel</button>
      </div>
    `

    const textarea = this.selectionToolbar.querySelector('.annotation-input') as HTMLTextAreaElement
    const saveBtn = this.selectionToolbar.querySelector('.annotation-save-btn')!
    const cancelBtn = this.selectionToolbar.querySelector('.annotation-cancel-btn')!

    // Focus input
    setTimeout(() => textarea.focus(), 0)

    // Save handler
    const save = async () => {
      const comment = textarea.value.trim()
      if (!comment) return

      await this.saveAnnotation(from, to, selectedText, comment)
      this.hideSelectionToolbar()
    }

    saveBtn.addEventListener('click', save)
    cancelBtn.addEventListener('click', () => this.hideSelectionToolbar())

    // Enter to save, Escape to cancel
    // Stop propagation to prevent toolbar hotkeys (like 'c') from triggering
    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        save()
      } else if (e.key === 'Escape') {
        this.hideSelectionToolbar()
      }
    })
  }

  private async saveAnnotation(from: number, to: number, selectedText: string, comment: string): Promise<void> {
    if (!this.currentContent) return

    const content = this.editorView?.state.doc.toString() || this.originalContent

    // Extract context for re-anchoring
    const contextBefore = content.slice(Math.max(0, from - 20), from)
    const contextAfter = content.slice(to, Math.min(content.length, to + 20))

    // Calculate line number (1-indexed)
    let line: number | undefined
    if (this.editorView) {
      const lineInfo = this.editorView.state.doc.lineAt(from)
      line = lineInfo.number
    }

    try {
      const response = await fetch(`http://${window.location.hostname}:4004/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: this.currentContent.path,
          originId: this.currentOriginId,
          from,
          to,
          line,
          originalText: selectedText,
          contextBefore,
          contextAfter,
          comment,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save annotation')
      }

      const data = await response.json()
      this.annotations.push(data.annotation)

      // Update highlights and panel
      this.updateAnnotationHighlights()
      this.renderAnnotationsPanel()
      this.updateSendButton()
    } catch (error: any) {
      console.error('Failed to save annotation:', error)
      alert(`Failed to save annotation: ${error.message}`)
    }
  }

  private updateAnnotationHighlights(): void {
    if (!this.editorView) return

    this.editorView.dispatch({
      effects: setAnnotationsEffect.of(this.annotations),
    })
  }

  // ============================================================================
  // Annotations Panel
  // ============================================================================

  private renderAnnotationsPanel(): void {
    const list = this.annotationsPanel.querySelector('.annotations-list')!

    if (this.annotations.length === 0) {
      list.innerHTML = '<div class="annotations-empty">No annotations yet. Select text to add one.</div>'
      return
    }

    list.innerHTML = this.annotations.map(ann => `
      <div class="annotation-item" data-id="${ann.id}">
        <div class="annotation-text">${ann.line ? `<span class="annotation-line">L${ann.line}</span> ` : ''}"${this.escapeHtml(this.truncate(ann.originalText, 50))}"</div>
        <div class="annotation-comment">${this.escapeHtml(ann.comment)}</div>
        <div class="annotation-meta">
          <span>${this.formatDate(ann.createdAt)}</span>
          <div class="annotation-actions">
            <button class="annotation-edit" title="Edit">✎</button>
            <button class="annotation-goto" title="Go to">↗</button>
            <button class="annotation-delete" title="Delete">×</button>
          </div>
        </div>
      </div>
    `).join('')

    // Add event listeners
    list.querySelectorAll('.annotation-item').forEach(item => {
      const id = item.getAttribute('data-id')!

      item.querySelector('.annotation-goto')?.addEventListener('click', () => {
        const ann = this.annotations.find(a => a.id === id)
        if (ann && this.editorView) {
          // Scroll to annotation
          this.editorView.dispatch({
            selection: { anchor: ann.from, head: ann.to },
            scrollIntoView: true,
          })
        }
      })

      item.querySelector('.annotation-delete')?.addEventListener('click', async () => {
        await this.deleteAnnotation(id)
      })

      item.querySelector('.annotation-edit')?.addEventListener('click', () => {
        this.startEditAnnotation(item as HTMLElement, id)
      })
    })
  }

  private startEditAnnotation(item: HTMLElement, id: string): void {
    const ann = this.annotations.find(a => a.id === id)
    if (!ann) return

    const commentDiv = item.querySelector('.annotation-comment')
    if (!commentDiv) return

    // Replace comment with inline edit form
    const currentComment = ann.comment
    commentDiv.innerHTML = `
      <textarea class="annotation-edit-input">${this.escapeHtml(currentComment)}</textarea>
      <div class="annotation-edit-actions">
        <button class="annotation-edit-save">Save</button>
        <button class="annotation-edit-cancel">Cancel</button>
      </div>
    `

    const textarea = commentDiv.querySelector('.annotation-edit-input') as HTMLTextAreaElement
    const saveBtn = commentDiv.querySelector('.annotation-edit-save')!
    const cancelBtn = commentDiv.querySelector('.annotation-edit-cancel')!

    // Focus and select
    textarea.focus()
    textarea.select()

    // Auto-resize textarea
    textarea.style.height = 'auto'
    textarea.style.height = textarea.scrollHeight + 'px'

    // Save handler
    const save = async () => {
      const newComment = textarea.value.trim()
      if (!newComment || newComment === currentComment) {
        cancel()
        return
      }
      await this.updateAnnotation(id, newComment)
    }

    // Cancel handler
    const cancel = () => {
      commentDiv.textContent = currentComment
    }

    saveBtn.addEventListener('click', save)
    cancelBtn.addEventListener('click', cancel)

    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        save()
      } else if (e.key === 'Escape') {
        cancel()
      }
    })
  }

  private async updateAnnotation(id: string, comment: string): Promise<void> {
    try {
      const response = await fetch(`http://${window.location.hostname}:4004/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to update annotation')
      }

      // Update local state
      const ann = this.annotations.find(a => a.id === id)
      if (ann) {
        ann.comment = comment
      }

      // Re-render panel
      this.renderAnnotationsPanel()
    } catch (error: any) {
      console.error('Failed to update annotation:', error)
      alert(`Failed to update annotation: ${error.message}`)
    }
  }

  private async deleteAnnotation(id: string): Promise<void> {
    try {
      const response = await fetch(`http://${window.location.hostname}:4004/annotations/${id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete annotation')
      }

      this.annotations = this.annotations.filter(a => a.id !== id)
      this.updateAnnotationHighlights()
      this.renderAnnotationsPanel()
      this.updateSendButton()
    } catch (error: any) {
      console.error('Failed to delete annotation:', error)
      alert(`Failed to delete annotation: ${error.message}`)
    }
  }

  private async clearAllAnnotations(): Promise<void> {
    try {
      // Delete all annotations in parallel
      await Promise.all(
        this.annotations.map(ann =>
          fetch(`http://${window.location.hostname}:4004/annotations/${ann.id}`, {
            method: 'DELETE',
          })
        )
      )

      this.annotations = []
      this.updateAnnotationHighlights()
      this.renderAnnotationsPanel()
      this.updateSendButton()
    } catch (error: any) {
      console.error('Failed to clear annotations:', error)
      alert(`Failed to clear annotations: ${error.message}`)
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.slice(0, maxLength) + '...'
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`

    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`

    return date.toLocaleDateString()
  }

  // ============================================================================
  // Send to Worker
  // ============================================================================

  private updateSendButton(): void {
    this.sendBtn.style.display = this.annotations.length > 0 ? 'inline-block' : 'none'
  }

  private async showWorkerPicker(): Promise<void> {
    if (this.annotations.length === 0) return

    // If we have a source worker, send directly (global comment is already tracked in state)
    if (this.sourceWorkerId) {
      await this.sendToWorker(this.sourceWorkerId)
      return
    }

    // Otherwise, need to pick a worker
    if (!this.currentContent) return

    // Fetch workers for this city
    if (this.onGetWorkers) {
      try {
        this.cityWorkers = await this.onGetWorkers(this.currentOriginId, this.currentContent.path)
      } catch (e) {
        console.error('Failed to get workers:', e)
        this.cityWorkers = []
      }
    }

    // Show picker modal
    const picker = document.createElement('div')
    picker.className = 'worker-picker-overlay'
    picker.innerHTML = `
      <div class="worker-picker">
        <div class="worker-picker-header">
          <span>Send annotations to worker</span>
          <button class="worker-picker-close">&times;</button>
        </div>
        <div class="worker-picker-list">
          <button class="worker-picker-item worker-picker-new" data-action="new">
            <span class="worker-name">+ New Worker</span>
            <span class="worker-session">Create new worker and send</span>
          </button>
          ${this.cityWorkers.map(w => `
            <button class="worker-picker-item" data-worker-id="${w.id}">
              <span class="worker-name">${this.escapeHtml(w.name)}</span>
              <span class="worker-session">${this.escapeHtml(w.tmuxSession)}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `

    document.body.appendChild(picker)

    // Event handlers
    picker.querySelector('.worker-picker-close')?.addEventListener('click', () => {
      picker.remove()
    })

    picker.addEventListener('click', (e) => {
      if (e.target === picker) picker.remove()
    })

    // Handle "New Worker" button
    picker.querySelector('.worker-picker-new')?.addEventListener('click', async () => {
      picker.remove()
      await this.sendToNewWorker()
    })

    // Handle existing worker buttons
    picker.querySelectorAll('.worker-picker-item:not(.worker-picker-new)').forEach(item => {
      item.addEventListener('click', async () => {
        const workerId = item.getAttribute('data-worker-id')!
        picker.remove()
        await this.sendToWorker(workerId)
      })
    })
  }

  private async sendToWorker(workerId: string): Promise<void> {
    if (!this.currentContent || this.annotations.length === 0) return

    try {
      const response = await fetch(`http://${window.location.hostname}:4004/send-annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerId,
          filePath: this.currentContent.path,
          originId: this.currentOriginId,
          annotations: this.annotations,
          globalComment: this.globalComment || undefined,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to send annotations')
      }

      // Show success feedback
      const originalText = this.sendBtn.textContent
      this.sendBtn.textContent = 'Sent!'
      setTimeout(() => {
        this.sendBtn.textContent = originalText
      }, 2000)
    } catch (error: any) {
      console.error('Failed to send annotations:', error)
      alert(`Failed to send annotations: ${error.message}`)
    }
  }

  private async sendToNewWorker(): Promise<void> {
    if (!this.currentContent || this.annotations.length === 0) return

    try {
      // Show loading state
      this.sendBtn.textContent = 'Creating...'
      this.sendBtn.setAttribute('disabled', 'true')

      const response = await fetch(`http://${window.location.hostname}:4004/send-annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          createNewWorker: true,
          filePath: this.currentContent.path,
          originId: this.currentOriginId,
          annotations: this.annotations,
          globalComment: this.globalComment || undefined,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to send annotations')
      }

      // Show success feedback
      this.sendBtn.textContent = 'Sent!'
      this.sendBtn.removeAttribute('disabled')
      setTimeout(() => {
        this.sendBtn.textContent = 'Send to Worker'
      }, 2000)
    } catch (error: any) {
      console.error('Failed to send annotations:', error)
      this.sendBtn.textContent = 'Send to Worker'
      this.sendBtn.removeAttribute('disabled')
      alert(`Failed to send annotations: ${error.message}`)
    }
  }
}
