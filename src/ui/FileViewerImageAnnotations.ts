import type { Annotation } from './FileViewerAnnotationTypes'

interface FileViewerImageAnnotationHost {
  panelEl: HTMLElement
  scheduleDeferredUiTask: (task: () => void, delayMs: number) => number
  getAnnotations: () => Annotation[]
  saveImageAnnotation: (x: number, y: number, comment: string) => Promise<Annotation | null>
}

export class FileViewerImageAnnotations {
  private host: FileViewerImageAnnotationHost
  private outsideClickHandler: ((event: MouseEvent) => void) | null = null
  private outsideClickTimer: number | null = null

  constructor(host: FileViewerImageAnnotationHost) {
    this.host = host
  }

  reset(): void {
    this.clearOutsideClick()
  }

  getRuntimeStats(): {
    hasOutsideClickHandler: boolean
    hasOutsideClickTimer: boolean
  } {
    return {
      hasOutsideClickHandler: this.outsideClickHandler !== null,
      hasOutsideClickTimer: this.outsideClickTimer !== null,
    }
  }

  setupImageAnnotation(container: HTMLElement, img: HTMLImageElement): void {
    img.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()

      const rect = img.getBoundingClientRect()
      const x = ((event.clientX - rect.left) / rect.width) * 100
      const y = ((event.clientY - rect.top) / rect.height) * 100

      this.showAnnotationInput(container, x, y, event.clientX, event.clientY)
    })

    img.style.cursor = 'crosshair'
  }

  renderMarkers(container: HTMLElement): void {
    container.querySelectorAll('.image-annotation-marker').forEach(marker => marker.remove())

    for (const [index, ann] of this.host.getAnnotations().entries()) {
      if (!ann.isImageAnnotation || ann.x === undefined || ann.y === undefined) continue

      const marker = document.createElement('div')
      marker.className = 'image-annotation-marker'
      marker.style.position = 'absolute'
      marker.style.left = `${ann.x}%`
      marker.style.top = `${ann.y}%`
      marker.style.transform = 'translate(-50%, -50%)'
      marker.style.width = '24px'
      marker.style.height = '24px'
      marker.style.borderRadius = '50%'
      marker.style.backgroundColor = 'var(--gold)'
      marker.style.border = '2px solid var(--bg-elevated)'
      marker.style.cursor = 'pointer'
      marker.style.display = 'flex'
      marker.style.alignItems = 'center'
      marker.style.justifyContent = 'center'
      marker.style.fontSize = '12px'
      marker.style.fontWeight = 'bold'
      marker.style.color = 'var(--bg-card)'
      marker.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)'
      marker.textContent = String(index + 1)
      marker.title = ann.comment
      marker.addEventListener('click', (event) => {
        event.stopPropagation()
        const annItem = this.host.panelEl.querySelector(`[data-annotation-id="${ann.id}"]`)
        if (!annItem) return
        annItem.scrollIntoView({ behavior: 'smooth', block: 'center' })
        annItem.classList.add('highlight')
        this.host.scheduleDeferredUiTask(() => annItem.classList.remove('highlight'), 1500)
      })
      container.appendChild(marker)
    }
  }

  dispose(): void {
    this.clearOutsideClick()
  }

  private showAnnotationInput(
    container: HTMLElement,
    x: number,
    y: number,
    screenX: number,
    screenY: number,
  ): void {
    container.querySelector('.image-annotation-input-wrapper')?.remove()
    this.clearOutsideClick()

    const wrapper = document.createElement('div')
    wrapper.className = 'image-annotation-input-wrapper'
    wrapper.style.position = 'fixed'
    wrapper.style.left = `${screenX + 10}px`
    wrapper.style.top = `${screenY + 10}px`
    wrapper.style.zIndex = '10001'
    wrapper.innerHTML = `
      <div class="image-annotation-input">
        <div class="image-annotation-marker-preview" style="background: var(--gold); width: 12px; height: 12px; border-radius: 50%; margin-bottom: 8px;"></div>
        <textarea class="annotation-input" placeholder="Add annotation..." rows="2"></textarea>
        <div class="annotation-input-actions">
          <button class="annotation-save-btn">Save</button>
          <button class="annotation-cancel-btn">Cancel</button>
        </div>
      </div>
    `

    document.body.appendChild(wrapper)

    const textarea = wrapper.querySelector('.annotation-input') as HTMLTextAreaElement | null
    const save = async () => {
      const comment = textarea?.value.trim() || ''
      if (!comment) return
      const annotation = await this.host.saveImageAnnotation(x, y, comment)
      if (!annotation) return
      wrapper.remove()
      this.clearOutsideClick()
      this.renderMarkers(container)
    }
    const cancel = () => {
      wrapper.remove()
      this.clearOutsideClick()
    }

    wrapper.querySelector('.annotation-save-btn')?.addEventListener('click', () => {
      void save()
    })
    wrapper.querySelector('.annotation-cancel-btn')?.addEventListener('click', cancel)
    textarea?.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void save()
      } else if (event.key === 'Escape') {
        cancel()
      }
    })
    window.setTimeout(() => textarea?.focus(), 0)

    const closeOnClickOutside = (event: MouseEvent) => {
      if (wrapper.contains(event.target as Node)) return
      wrapper.remove()
      this.clearOutsideClick()
    }
    this.outsideClickHandler = closeOnClickOutside
    this.outsideClickTimer = window.setTimeout(() => {
      this.outsideClickTimer = null
      if (this.outsideClickHandler === closeOnClickOutside) {
        document.addEventListener('click', closeOnClickOutside)
      }
    }, 0)
  }

  private clearOutsideClick(): void {
    if (this.outsideClickTimer !== null) {
      window.clearTimeout(this.outsideClickTimer)
      this.outsideClickTimer = null
    }
    if (!this.outsideClickHandler) return
    document.removeEventListener('click', this.outsideClickHandler)
    this.outsideClickHandler = null
  }
}
