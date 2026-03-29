import { renderPdfAllPages } from './ArtifactMedia'
import { escapeHtml, highlightCodeBlocks, renderMarkdown } from './utils'

const MIN_MODAL_WIDTH = 400
const MAX_MODAL_WIDTH_FRACTION = 0.95

export class TapestryStaticFileModal {
  private modal: HTMLElement | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private readonly staticDataBase: string

  constructor(staticDataBase: string) {
    this.staticDataBase = staticDataBase
  }

  isOpen(): boolean {
    return this.modal !== null
  }

  close(): void {
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler)
      this.keyHandler = null
    }
    if (this.modal) {
      this.modal.remove()
      this.modal = null
      return
    }
    document.querySelector('.tapestry-file-modal')?.remove()
  }

  private resolveFileUrl(href: string): string {
    // Files exported by the old TS script are stored flat in files/ with / → _
    // Files referenced in fiber text may be project-relative paths
    const flatName = href.replace(/^\.{0,2}\//, '').replace(/\//g, '_')
    return `${this.staticDataBase}/files/${flatName}`
  }

  async open(href: string, line?: number): Promise<void> {
    if (!this.staticDataBase) return

    const filename = href.split('/').pop() || ''
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    const url = this.resolveFileUrl(href)
    const modal = this.ensureModal()
    if (!modal) return

    const titleEl = modal.querySelector('.tapestry-file-title') as HTMLElement
    const bodyEl = modal.querySelector('.tapestry-file-body') as HTMLElement
    titleEl.textContent = filename + (line ? `:${line}` : '')
    bodyEl.innerHTML = '<div style="padding:1rem;color:var(--ui-text-muted)">Loading...</div>'

    if (ext === 'pdf') {
      bodyEl.innerHTML = ''
      const pdfContainer = document.createElement('div')
      pdfContainer.style.cssText = 'width:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;'
      bodyEl.appendChild(pdfContainer)
      renderPdfAllPages(url, pdfContainer)
      return
    }

    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
      bodyEl.innerHTML = `<img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;margin:auto;display:block;" />`
      return
    }

    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`${resp.status}`)
      const text = await resp.text()

      if (ext === 'md') {
        bodyEl.innerHTML = `<div class="tapestry-file-markdown">${renderMarkdown(text)}</div>`
        highlightCodeBlocks(bodyEl)
        return
      }

      const langMap: Record<string, string> = {
        tex: 'latex',
        py: 'python',
        ts: 'typescript',
        js: 'javascript',
        sh: 'bash',
        yaml: 'yaml',
        yml: 'yaml',
        json: 'json',
        toml: 'toml',
      }
      const lang = langMap[ext] || ext
      const rows = text.split('\n').map((value, index) => {
        const number = index + 1
        const highlighted = line && number === line ? ' class="highlighted-line"' : ''
        return `<tr${highlighted}><td class="line-num">${number}</td><td class="line-content">${escapeHtml(value)}</td></tr>`
      }).join('')

      bodyEl.innerHTML = `<div class="tapestry-file-code" data-lang="${escapeHtml(lang)}"><table>${rows}</table></div>`

      const prism = (window as unknown as {
        Prism?: {
          highlight: (code: string, grammar: unknown, language: string) => string
          languages: Record<string, unknown>
        }
      }).Prism

      if (prism?.languages[lang]) {
        bodyEl.querySelectorAll<HTMLElement>('.line-content').forEach(cell => {
          cell.innerHTML = prism.highlight(cell.textContent || '', prism.languages[lang], lang)
        })
      }

      if (line) {
        bodyEl.querySelector('.highlighted-line')?.scrollIntoView({ block: 'center' })
      }
    } catch {
      bodyEl.innerHTML = `<div style="padding:1rem;color:var(--ui-text-muted)">Could not load file: ${escapeHtml(filename)}</div>`
    }
  }

  private ensureModal(): HTMLElement | null {
    if (this.modal && document.body.contains(this.modal)) {
      return this.modal
    }

    const modal = document.createElement('div')
    modal.className = 'tapestry-file-modal'
    modal.innerHTML = `
      <div class="tapestry-file-backdrop"></div>
      <div class="tapestry-file-content">
        <div class="tapestry-file-resize tapestry-file-resize-left"></div>
        <div class="tapestry-file-resize tapestry-file-resize-right"></div>
        <div class="tapestry-file-header">
          <span class="tapestry-file-title"></span>
          <button class="tapestry-file-close">&times;</button>
        </div>
        <div class="tapestry-file-body"></div>
      </div>
    `

    document.body.appendChild(modal)
    this.modal = modal
    modal.querySelector('.tapestry-file-backdrop')?.addEventListener('click', () => this.close())
    modal.querySelector('.tapestry-file-close')?.addEventListener('click', () => this.close())
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close()
    }
    document.addEventListener('keydown', this.keyHandler)

    const content = modal.querySelector('.tapestry-file-content') as HTMLElement | null
    if (!content) return modal

    const bindResize = (selector: string, direction: 1 | -1) => {
      modal.querySelector(selector)?.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = (e as MouseEvent).clientX
        const startWidth = content.getBoundingClientRect().width
        content.style.transition = 'none'

        const onMove = (event: MouseEvent) => {
          const delta = (event.clientX - startX) * direction * 2
          const maxWidth = window.innerWidth * MAX_MODAL_WIDTH_FRACTION
          const width = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth + delta))
          content.style.width = `${width}px`
        }

        const onUp = () => {
          content.style.transition = ''
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }

        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
    }

    bindResize('.tapestry-file-resize-right', 1)
    bindResize('.tapestry-file-resize-left', -1)
    return modal
  }
}
