import { renderPdfAllPages } from './utils'
import type { TapestryNode } from './tapestry-types'
import { artifactEntries, isPdfArtifact } from './tapestry-helpers'

type ArtifactUrlResolver = (specName: string, filePath: string) => string
type ImageAnnotationHandler = (node: TapestryNode, artifactName: string, x: number, y: number) => void

export class TapestryArtifactLightbox {
  private closeHandler: (() => void) | null = null
  private readonly resolveArtifactUrl: ArtifactUrlResolver
  private readonly promptImageAnnotation: ImageAnnotationHandler
  private readonly isStaticMode: () => boolean

  constructor(
    resolveArtifactUrl: ArtifactUrlResolver,
    promptImageAnnotation: ImageAnnotationHandler,
    isStaticMode: () => boolean,
  ) {
    this.resolveArtifactUrl = resolveArtifactUrl
    this.promptImageAnnotation = promptImageAnnotation
    this.isStaticMode = isStaticMode
  }

  isOpen(): boolean {
    return this.closeHandler !== null
  }

  close(): void {
    const close = this.closeHandler
    this.closeHandler = null
    close?.()
  }

  open(mediaEl: HTMLElement, node: TapestryNode): void {
    const entries = artifactEntries(node.evidence?.artifacts || {})
    if (entries.length === 0) return

    this.close()

    const lightbox = document.createElement('div')
    lightbox.className = 'tapestry-lightbox'

    const createMediaElement = (name: string, path: string): HTMLElement => {
      const url = this.resolveArtifactUrl(node.specName || '', path)
      if (isPdfArtifact(path)) {
        const container = document.createElement('div')
        container.className = 'tapestry-lightbox-pdf'
        container.dataset.artifactName = name
        container.dataset.artifactType = 'pdf'
        container.addEventListener('click', (e) => e.stopPropagation())
        renderPdfAllPages(url, container)
        return container
      }

      const image = document.createElement('img')
      image.src = url
      image.alt = name
      image.dataset.artifactName = name
      image.dataset.artifactType = 'image'
      return image
    }

    const selectedName = mediaEl.dataset.artifactName || ''
    let index = entries.findIndex(([name]) => name === selectedName)
    if (index < 0) {
      const triggerSrc = (mediaEl instanceof HTMLImageElement || mediaEl instanceof HTMLIFrameElement) ? mediaEl.src : ''
      index = entries.findIndex(([, path]) => this.resolveArtifactUrl(node.specName || '', path) === triggerSrc)
    }
    if (index < 0) index = 0

    let [name, path] = entries[index]
    let media = createMediaElement(name, path)
    let labelEl: HTMLElement | null = null

    const updateLabel = () => {
      if (!labelEl) return
      labelEl.textContent = `${entries[index][0]} (${index + 1}/${entries.length})`
    }

    if (entries.length > 1) {
      labelEl = document.createElement('span')
      labelEl.className = 'tapestry-lightbox-label'
      updateLabel()
    }

    const closeButton = document.createElement('button')
    closeButton.className = 'tapestry-lightbox-close'
    closeButton.textContent = '\u00D7'

    lightbox.appendChild(media)
    if (labelEl) lightbox.appendChild(labelEl)
    lightbox.appendChild(closeButton)

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      document.removeEventListener('keydown', keyHandler)
      if (this.closeHandler === close) {
        this.closeHandler = null
      }
      lightbox.remove()
    }

    const bindImageAnnotation = () => {
      if (this.isStaticMode() || !(media instanceof HTMLImageElement)) return
      media.addEventListener('click', (e) => {
        e.stopPropagation()
        const rect = media.getBoundingClientRect()
        const x = ((e.clientX - rect.left) / rect.width) * 100
        const y = ((e.clientY - rect.top) / rect.height) * 100
        this.promptImageAnnotation(node, media.dataset.artifactName || '', x, y)
        close()
      })
    }

    const navigate = (delta: number) => {
      index = (index + delta + entries.length) % entries.length
      ;[name, path] = entries[index]
      const nextMedia = createMediaElement(name, path)
      media.replaceWith(nextMedia)
      media = nextMedia
      bindImageAnnotation()
      updateLabel()
    }

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        return
      }
      if (entries.length <= 1) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        navigate(-1)
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        navigate(1)
      }
    }

    this.closeHandler = close
    closeButton.addEventListener('click', close)
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) close()
    })

    bindImageAnnotation()
    document.addEventListener('keydown', keyHandler)
    document.body.appendChild(lightbox)
  }
}
