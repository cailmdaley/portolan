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
import { vim } from '@replit/codemirror-vim'
import { type FileViewerAnnotations, fileViewerAnnotationHighlightField } from './FileViewerAnnotations'

const API_BASE = `http://${window.location.hostname}:4004`

export interface FileContent {
  content: string
  language: string
  path: string
  type?: 'text' | 'image'
  url?: string
}

interface FileViewerTextEditorOptions {
  contentEl: HTMLElement
  pathEl: HTMLElement
  modeLineEl: HTMLElement
  saveBtn: HTMLElement
  copyBtn: HTMLElement
  downloadBtn: HTMLElement
  annotations: FileViewerAnnotations
  scheduleDeferredUiTask: (task: () => void, delayMs: number) => number
  getOriginId: () => string
  isVisible: () => boolean
  onRenderMarkdown: (content: string) => void
}

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
  '.cm-fat-cursor': {
    backgroundColor: 'rgba(154, 123, 53, 0.7) !important',
    color: 'white !important',
  },
  '&:not(.cm-focused) .cm-fat-cursor': {
    backgroundColor: 'transparent !important',
    outline: '1px solid var(--gold)',
  },
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
  '.cm-annotation-highlight': {
    backgroundColor: 'rgba(154, 123, 53, 0.2)',
    borderBottom: '2px solid var(--gold)',
    cursor: 'pointer',
  },
}, { dark: false })

export class FileViewerTextEditor {
  private contentEl: HTMLElement
  private pathEl: HTMLElement
  private modeLineEl: HTMLElement
  private saveBtn: HTMLElement
  private copyBtn: HTMLElement
  private downloadBtn: HTMLElement
  private annotations: FileViewerAnnotations
  private scheduleDeferredUiTask: FileViewerTextEditorOptions['scheduleDeferredUiTask']
  private getOriginId: () => string
  private isVisible: () => boolean
  private onRenderMarkdown: (content: string) => void

  private editorView: EditorView | null = null
  private currentContent: FileContent | null = null
  private originalContent = ''
  private isDirty = false

  constructor(options: FileViewerTextEditorOptions) {
    this.contentEl = options.contentEl
    this.pathEl = options.pathEl
    this.modeLineEl = options.modeLineEl
    this.saveBtn = options.saveBtn
    this.copyBtn = options.copyBtn
    this.downloadBtn = options.downloadBtn
    this.annotations = options.annotations
    this.scheduleDeferredUiTask = options.scheduleDeferredUiTask
    this.getOriginId = options.getOriginId
    this.isVisible = options.isVisible
    this.onRenderMarkdown = options.onRenderMarkdown
  }

  getCurrentContent(): FileContent | null {
    return this.currentContent
  }

  setCurrentContent(content: FileContent | null): void {
    this.currentContent = content
    this.originalContent = content?.content || ''
    this.isDirty = false
    this.updateDirtyIndicator()
  }

  hasEditorView(): boolean {
    return this.editorView !== null
  }

  getEditorView(): EditorView | null {
    return this.editorView
  }

  hasEditorFocus(): boolean {
    return this.editorView?.hasFocus ?? false
  }

  getIsDirty(): boolean {
    return this.isDirty
  }

  getOriginalContent(): string {
    return this.originalContent
  }

  isMarkdownFile(filePath: string): boolean {
    if (!this.currentContent) return false
    return this.currentContent.language === 'markdown' || /\.(md|markdown)$/i.test(filePath)
  }

  showEditor(jumpToLine?: number, focus = true): void {
    if (!this.currentContent) return
    this.createEditor(this.currentContent.content, this.currentContent.language, focus)
    if (jumpToLine && jumpToLine > 0) {
      this.scrollToLine(jumpToLine)
    }
  }

  enterMarkdownEditMode(): void {
    if (!this.currentContent) return
    this.createEditor(this.currentContent.content, this.currentContent.language, true)
    this.modeLineEl.textContent = ''
  }

  exitMarkdownEditMode(): void {
    if (!this.currentContent) return
    const content = this.editorView?.state.doc.toString() || this.currentContent.content
    this.currentContent.content = content
    this.originalContent = content
    this.isDirty = false
    this.updateDirtyIndicator()
    this.destroyEditor()
    this.onRenderMarkdown(content)
  }

  async save(): Promise<void> {
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
          originId: this.getOriginId(),
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save file')
      }

      this.currentContent.content = content
      this.originalContent = content
      this.isDirty = false
      this.updateDirtyIndicator()

      this.saveBtn.textContent = 'Saved!'
      this.scheduleDeferredUiTask(() => {
        if (!this.isVisible()) return
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

  async copyToClipboard(): Promise<void> {
    const content = this.getTextContent()
    if (!content) return

    try {
      await navigator.clipboard.writeText(content)
      const originalText = this.copyBtn.textContent
      this.copyBtn.textContent = 'Copied!'
      this.scheduleDeferredUiTask(() => {
        if (!this.isVisible()) return
        this.copyBtn.textContent = originalText
      }, 1500)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = content
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      this.copyBtn.textContent = 'Copied!'
      this.scheduleDeferredUiTask(() => {
        if (!this.isVisible()) return
        this.copyBtn.textContent = 'Copy'
      }, 1500)
    }
  }

  download(): void {
    const content = this.getTextContent()
    if (!content) return

    const filename = this.currentContent?.path.split('/').pop() || 'download.txt'
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    const originalText = this.downloadBtn.textContent
    this.downloadBtn.textContent = 'Downloaded!'
    this.scheduleDeferredUiTask(() => {
      if (!this.isVisible()) return
      this.downloadBtn.textContent = originalText
    }, 1500)
  }

  reset(): void {
    this.currentContent = null
    this.originalContent = ''
    this.isDirty = false
    this.updateDirtyIndicator()
    this.destroyEditor()
  }

  destroy(): void {
    this.destroyEditor()
  }

  private createEditor(content: string, language: string, focus: boolean): void {
    this.destroyEditor()
    this.contentEl.innerHTML = ''

    const langExtension = this.getLanguageExtension(language)
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
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString()
          const wasDirty = this.isDirty
          this.isDirty = newContent !== this.originalContent
          if (wasDirty !== this.isDirty) {
            this.updateDirtyIndicator()
          }
        }
        this.updateModeLine(update.state)
        if (update.selectionSet) {
          this.annotations.handleEditorSelection(update.state)
        }
      }),
    ]

    if (langExtension) {
      extensions.push(langExtension)
    }

    const state = EditorState.create({
      doc: content,
      extensions,
    })

    this.editorView = new EditorView({
      state,
      parent: this.contentEl,
    })

    this.annotations.updateAnnotationHighlights()
    this.updateModeLine(state)

    if (focus) {
      this.editorView.focus()
    }
  }

  private destroyEditor(): void {
    if (!this.editorView) return
    this.editorView.destroy()
    this.editorView = null
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
    this.pathEl.classList.toggle('dirty', this.isDirty)
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
}
