// CityPanel.ts - DOM overlay for city details and fibers

import { marked } from 'marked'
import katex from 'katex'
import type { City } from '../state/types'

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
})

export interface Fiber {
  id: string
  title: string
  status: string
  kind: string
  priority: number
  createdAt: string
  body?: string
  reason?: string
}

interface FibersResponse {
  type: 'fibers'
  cityId: string
  open: Fiber[]
  recentlyClosed: Fiber[]
}

type FibersCallback = (response: FibersResponse) => void

export class CityPanel {
  private panel: HTMLElement
  private closeBtn: HTMLElement
  private resizeHandle: HTMLElement
  private cityName: HTMLElement
  private cityPath: HTMLElement
  private openFibersList: HTMLElement
  private closedFibersList: HTMLElement
  private currentCity: City | null = null
  private ws: WebSocket | null = null
  private fibersCallback: FibersCallback | null = null
  private ignoreNextClick = false
  private isResizing = false
  private minWidth = 280
  private maxWidth = 600

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.resizeHandle = this.panel.querySelector('.resize-handle')!
    this.cityName = this.panel.querySelector('.city-name')!
    this.cityPath = this.panel.querySelector('.city-path')!
    this.openFibersList = this.panel.querySelector('.open-fibers')!
    this.closedFibersList = this.panel.querySelector('.closed-fibers')!

    this.setupEventListeners()
    this.setupResizeHandling()
    document.body.appendChild(this.panel)
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.id = 'city-panel'
    panel.className = 'panel'
    panel.innerHTML = `
      <div class="resize-handle"></div>
      <button class="close-btn">&times;</button>
      <h2 class="city-name"></h2>
      <p class="city-path"></p>
      <section class="fibers">
        <h3>Open Fibers</h3>
        <ul class="fiber-list open-fibers"></ul>
      </section>
      <section class="fibers">
        <h3>Recently Closed</h3>
        <ul class="fiber-list closed-fibers"></ul>
      </section>
    `
    return panel
  }

  private setupEventListeners(): void {
    // Close button
    this.closeBtn.addEventListener('click', () => this.hide())

    // Click outside to close (use setTimeout to let current click propagate)
    document.addEventListener('click', (e) => {
      if (this.ignoreNextClick) {
        this.ignoreNextClick = false
        return
      }
      if (this.panel.classList.contains('visible')) {
        const target = e.target as HTMLElement
        if (!this.panel.contains(target)) {
          this.hide()
        }
      }
    })

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panel.classList.contains('visible')) {
        this.hide()
      }
    })
  }

  private setupResizeHandling(): void {
    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizing) return
      const newWidth = window.innerWidth - e.clientX
      const clampedWidth = Math.min(this.maxWidth, Math.max(this.minWidth, newWidth))
      this.panel.style.width = `${clampedWidth}px`
    }

    const onMouseUp = () => {
      if (this.isResizing) {
        this.isResizing = false
        this.resizeHandle.classList.remove('dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    this.resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.isResizing = true
      this.resizeHandle.classList.add('dragging')
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
    })

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws
  }

  handleMessage(message: unknown): boolean {
    const msg = message as { type?: string }
    if (msg.type === 'fibers') {
      const response = message as FibersResponse
      if (this.fibersCallback) {
        this.fibersCallback(response)
        this.fibersCallback = null
      }
      return true
    }
    return false
  }

  show(city: City): void {
    this.currentCity = city
    this.cityName.textContent = city.name
    this.cityPath.textContent = city.path

    // Clear previous fibers
    this.openFibersList.innerHTML = '<li class="loading">Loading fibers...</li>'
    this.closedFibersList.innerHTML = ''

    // Ignore the click that triggered this show
    this.ignoreNextClick = true

    // Show panel
    this.panel.classList.add('visible')

    // Request fibers from server
    this.requestFibers(city.id)
  }

  private requestFibers(cityId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.openFibersList.innerHTML = '<li class="empty">No connection</li>'
      return
    }

    this.fibersCallback = (response) => {
      if (response.cityId === this.currentCity?.id) {
        this.renderFibers(response.open, response.recentlyClosed)
      }
    }

    this.ws.send(JSON.stringify({ type: 'getFibers', cityId }))
  }

  private renderFibers(open: Fiber[], closed: Fiber[]): void {
    // Render open fibers
    if (open.length === 0) {
      this.openFibersList.innerHTML = '<li class="empty">No open fibers</li>'
    } else {
      this.openFibersList.innerHTML = open.map(f => this.renderFiberItem(f)).join('')
    }

    // Render closed fibers
    if (closed.length === 0) {
      this.closedFibersList.innerHTML = '<li class="empty">None recently</li>'
    } else {
      this.closedFibersList.innerHTML = closed.map(f => this.renderFiberItem(f, true)).join('')
    }

    // Attach expand listeners (only for items with content)
    this.panel.querySelectorAll('.fiber-item.has-content').forEach(item => {
      item.addEventListener('click', () => {
        item.classList.toggle('expanded')
      })
    })
  }

  private renderFiberItem(fiber: Fiber, closed = false): string {
    const statusIcon = fiber.status === 'active' ? '◐' : fiber.status === 'closed' ? '●' : '○'
    const kindClass = fiber.kind || 'task'
    const hasBody = !!fiber.body
    const hasReason = closed && !!fiber.reason
    const hasContent = hasBody || hasReason
    const contentClass = hasContent ? 'has-content' : ''
    // Use markdown rendering for body and reason
    const bodyHtml = hasBody ? `<div class="fiber-body">${this.renderMarkdown(fiber.body!)}</div>` : ''
    const reasonHtml = hasReason ? `<div class="fiber-reason">${this.renderMarkdown(fiber.reason!)}</div>` : ''

    return `
      <li class="fiber-item ${kindClass} ${contentClass}" data-id="${fiber.id}">
        <div class="fiber-header">
          <span class="fiber-status">${statusIcon}</span>
          <span class="fiber-title">${this.escapeHtml(fiber.title)}</span>
          <span class="fiber-kind">${fiber.kind || 'task'}</span>
        </div>
        ${bodyHtml}
        ${reasonHtml}
      </li>
    `
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * Render markdown with math support (KaTeX)
   * Supports $...$ for inline math and $$...$$ for display math
   */
  private renderMarkdown(text: string): string {
    // First, extract and protect math blocks
    const mathBlocks: { placeholder: string; rendered: string }[] = []
    let counter = 0

    // Handle display math ($$...$$)
    let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
      const placeholder = `%%MATH_DISPLAY_${counter++}%%`
      try {
        const rendered = katex.renderToString(math.trim(), {
          displayMode: true,
          throwOnError: false,
        })
        mathBlocks.push({ placeholder, rendered })
      } catch {
        mathBlocks.push({ placeholder, rendered: `<span class="math-error">$$${math}$$</span>` })
      }
      return placeholder
    })

    // Handle inline math ($...$)
    processed = processed.replace(/\$([^$\n]+?)\$/g, (_, math) => {
      const placeholder = `%%MATH_INLINE_${counter++}%%`
      try {
        const rendered = katex.renderToString(math.trim(), {
          displayMode: false,
          throwOnError: false,
        })
        mathBlocks.push({ placeholder, rendered })
      } catch {
        mathBlocks.push({ placeholder, rendered: `<span class="math-error">$${math}$</span>` })
      }
      return placeholder
    })

    // Render markdown
    let html = marked.parse(processed) as string

    // Restore math blocks
    for (const block of mathBlocks) {
      html = html.replace(block.placeholder, block.rendered)
    }

    return html
  }

  hide(): void {
    this.panel.classList.remove('visible')
    this.currentCity = null
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }
}
