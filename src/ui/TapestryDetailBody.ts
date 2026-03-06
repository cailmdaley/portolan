import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { vim } from '@replit/codemirror-vim'
import type { City } from '../state/types'
import type { TapestryNode } from './tapestry-types'
import { attachInlinePathListeners, highlightCodeBlocks, renderMarkdown, showToast } from './utils'

const API_BASE = `http://${window.location.hostname}:4004`

interface RenderOptions {
  container: HTMLElement
  body: string
  city: City | null
  interpolateConfig: (container: HTMLElement) => void
  openFileFromLink: (path: string, line?: number) => void
}

interface EditOptions {
  container: HTMLElement
  node: TapestryNode
  city: City | null
  onSave: () => void
}

export class TapestryDetailBody {
  private editorView: EditorView | null = null
  private editorNodeId: string | null = null

  isEditing(): boolean {
    return this.editorView !== null
  }

  getEditingNodeId(): string | null {
    return this.editorNodeId
  }

  render({ container, body, city, interpolateConfig, openFileFromLink }: RenderOptions): void {
    container.classList.remove('editing', 'dirty')
    const markdownOptions = city
      ? { basePath: `${city.path}/.felt`, originId: city.originId }
      : undefined
    container.innerHTML = renderMarkdown(body, markdownOptions)
    highlightCodeBlocks(container)
    interpolateConfig(container)
    attachInlinePathListeners(container, (path, line) => openFileFromLink(path, line))
  }

  enterEditMode({ container, node, city, onSave }: EditOptions): boolean {
    if (!node.body || !city) return false

    this.destroy()
    container.classList.add('editing')
    container.innerHTML = ''

    const editorTheme = EditorView.theme({
      '&': {
        fontSize: '0.85rem',
        fontFamily: 'var(--font-mono)',
        background: 'transparent',
        maxHeight: '100%',
      },
      '.cm-content': {
        fontFamily: 'var(--font-mono)',
        caretColor: 'var(--ui-gold)',
        padding: '0',
      },
      '.cm-gutters': {
        background: 'transparent',
        border: 'none',
        color: 'var(--ui-text-muted)',
      },
      '.cm-activeLine': {
        background: 'rgba(154, 123, 53, 0.06)',
      },
      '.cm-cursor': {
        borderLeftColor: 'var(--ui-gold)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        background: 'rgba(90, 123, 123, 0.2) !important',
      },
      '.cm-line': {
        padding: '0 0.2rem',
      },
    })

    const extensions: Extension[] = [
      vim(),
      lineNumbers(),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      highlightActiveLine(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        { key: 'Mod-s', run: () => { onSave(); return true } },
      ]),
      markdown(),
      editorTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          container.classList.toggle('dirty', update.state.doc.toString() !== node.body)
        }
      }),
    ]

    const state = EditorState.create({
      doc: node.body,
      extensions,
    })

    this.editorView = new EditorView({ state, parent: container })
    this.editorNodeId = node.id
    this.editorView.focus()
    return true
  }

  async save(node: TapestryNode, city: City): Promise<string | null> {
    if (!this.editorView) return null

    const newContent = this.editorView.state.doc.toString()
    const filePath = `${city.path}/.felt/${node.id}.md`

    try {
      const response = await fetch(
        `${API_BASE}/file-content?path=${encodeURIComponent(filePath)}&originId=${encodeURIComponent(city.originId)}`
      )
      if (!response.ok) throw new Error('Failed to read fiber file')
      const data = await response.json()
      const existingContent: string = data.content

      const fmEnd = existingContent.indexOf('\n---\n')
      const updatedContent = fmEnd >= 0
        ? `${existingContent.slice(0, fmEnd + 5)}\n${newContent}`
        : newContent

      const saveResponse = await fetch(`${API_BASE}/save-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          content: updatedContent,
          originId: city.originId,
        }),
      })
      if (!saveResponse.ok) throw new Error('Failed to save fiber file')

      showToast('Saved', 'success', 1500)
      return newContent
    } catch (error: any) {
      showToast(`Save failed: ${error.message}`, 'error')
      return null
    }
  }

  destroy(): void {
    if (!this.editorView) return
    this.editorView.destroy()
    this.editorView = null
    this.editorNodeId = null
  }
}
