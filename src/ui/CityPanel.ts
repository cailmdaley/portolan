// CityPanel.ts - DOM overlay for city details and fibers

import { marked } from 'marked'
import katex from 'katex'
import type { City, GitStatus } from '../state/types'

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
  private gitStatusEl: HTMLElement
  private newWorkerBtn: HTMLElement
  private viewClaimsBtn: HTMLElement
  private searchInput: HTMLInputElement
  private searchClear: HTMLElement
  private openFibersList: HTMLElement
  private closedFibersList: HTMLElement
  private currentCity: City | null = null
  private ws: WebSocket | null = null
  private fibersCallback: FibersCallback | null = null
  private ignoreNextClick = false
  private isResizing = false
  private minWidth = 280
  private maxWidth = 600
  // Store fibers for filtering
  private openFibers: Fiber[] = []
  private closedFibers: Fiber[] = []
  // Callback for View Claims button
  private onViewClaims: ((city: City) => void) | null = null

  constructor() {
    this.panel = this.createPanel()
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.resizeHandle = this.panel.querySelector('.resize-handle')!
    this.cityName = this.panel.querySelector('.city-name')!
    this.cityPath = this.panel.querySelector('.city-path')!
    this.gitStatusEl = this.panel.querySelector('.git-status')!
    this.newWorkerBtn = this.panel.querySelector('.new-worker-btn')!
    this.viewClaimsBtn = this.panel.querySelector('.view-claims-btn')!
    this.searchInput = this.panel.querySelector('.search-input')!
    this.searchClear = this.panel.querySelector('.search-clear')!
    this.openFibersList = this.panel.querySelector('.open-fibers')!
    this.closedFibersList = this.panel.querySelector('.closed-fibers')!

    this.setupEventListeners()
    this.setupResizeHandling()
    this.setupSearch()
    document.body.appendChild(this.panel)
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.id = 'city-panel'
    panel.className = 'panel dark-theme'  // Fireside Command: dark UI over warm map
    panel.innerHTML = `
      <div class="resize-handle"></div>
      <button class="close-btn">&times;</button>
      <h2 class="city-name"></h2>
      <p class="city-path"></p>
      <div class="git-status"></div>
      <button class="new-worker-btn">+ New Worker</button>
      <button class="view-claims-btn" style="display: none;">View Claims</button>
      <div class="search-container">
        <input type="text" class="search-input" placeholder="Filter fibers…" />
        <button class="search-clear" aria-label="Clear search">&times;</button>
      </div>
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

    // New worker button
    this.newWorkerBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.requestNewWorker()
    })

    // View claims button
    this.viewClaimsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.currentCity && this.onViewClaims) {
        this.onViewClaims(this.currentCity)
      }
    })

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

  private setupSearch(): void {
    this.searchInput.addEventListener('input', () => {
      this.filterFibers()
      this.updateSearchClearVisibility()
    })

    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = ''
      this.filterFibers()
      this.updateSearchClearVisibility()
      this.searchInput.focus()
    })

    // Start with clear button hidden
    this.updateSearchClearVisibility()
  }

  private updateSearchClearVisibility(): void {
    this.searchClear.style.display = this.searchInput.value ? 'block' : 'none'
  }

  private filterFibers(): void {
    const query = this.searchInput.value.toLowerCase().trim()

    if (!query) {
      // No filter — render all
      this.renderFilteredFibers(this.openFibers, this.closedFibers)
      return
    }

    const matchesFiber = (f: Fiber): boolean => {
      return (
        f.title.toLowerCase().includes(query) ||
        f.kind.toLowerCase().includes(query) ||
        (f.body?.toLowerCase().includes(query) ?? false) ||
        (f.reason?.toLowerCase().includes(query) ?? false)
      )
    }

    const filteredOpen = this.openFibers.filter(matchesFiber)
    const filteredClosed = this.closedFibers.filter(matchesFiber)
    this.renderFilteredFibers(filteredOpen, filteredClosed)
  }

  private renderFilteredFibers(open: Fiber[], closed: Fiber[]): void {
    // Render open fibers
    if (open.length === 0) {
      const msg = this.searchInput.value ? 'No matches' : 'No open fibers'
      this.openFibersList.innerHTML = `<li class="empty">${msg}</li>`
    } else {
      this.openFibersList.innerHTML = open.map(f => this.renderFiberItem(f)).join('')
    }

    // Render closed fibers
    if (closed.length === 0) {
      const msg = this.searchInput.value ? 'No matches' : 'None recently'
      this.closedFibersList.innerHTML = `<li class="empty">${msg}</li>`
    } else {
      this.closedFibersList.innerHTML = closed.map(f => this.renderFiberItem(f, true)).join('')
    }

    // Attach event listeners
    this.attachExpandListeners()
    this.attachHandoffListeners()
  }

  private attachExpandListeners(): void {
    this.panel.querySelectorAll('.fiber-item.has-content').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't expand if clicking on a link or button
        if ((e.target as HTMLElement).closest('a, button')) return
        item.classList.toggle('expanded')
      })
    })
  }

  private attachHandoffListeners(): void {
    this.panel.querySelectorAll('.handoff-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const fiberId = (btn as HTMLElement).dataset.fiberId
        if (fiberId && this.currentCity) {
          this.sendHandoff(fiberId, this.currentCity.path)
        }
      })
    })
  }

  private sendHandoff(fiberId: string, cityPath: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('No connection for handoff')
      return
    }
    this.ws.send(JSON.stringify({ type: 'handoff', fiberId, cityPath }))
  }

  private requestNewWorker(): void {
    if (!this.currentCity) {
      console.error('No city selected')
      return
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('No connection for new worker')
      return
    }
    console.log('Requesting new worker for:', this.currentCity.path)
    this.ws.send(JSON.stringify({ type: 'newWorker', cityPath: this.currentCity.path }))
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws
  }

  setOnViewClaims(callback: (city: City) => void): void {
    this.onViewClaims = callback
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

    // Render git status
    this.renderGitStatus(city.gitStatus)

    // Show/hide View Claims button based on hasClaims
    this.viewClaimsBtn.style.display = city.hasClaims ? 'block' : 'none'

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

  /**
   * Render git status section
   */
  private renderGitStatus(status?: GitStatus): void {
    if (!status || !status.isRepo) {
      this.gitStatusEl.innerHTML = ''
      this.gitStatusEl.style.display = 'none'
      return
    }

    this.gitStatusEl.style.display = 'block'

    // Build status line
    const parts: string[] = []

    // Branch name
    parts.push(`<span class="git-branch">${this.escapeHtml(status.branch)}</span>`)

    // Ahead/behind
    if (status.ahead > 0 || status.behind > 0) {
      const syncParts: string[] = []
      if (status.ahead > 0) syncParts.push(`↑${status.ahead}`)
      if (status.behind > 0) syncParts.push(`↓${status.behind}`)
      parts.push(`<span class="git-sync">${syncParts.join(' ')}</span>`)
    }

    // Changes
    const changes: string[] = []
    if (status.staged.added > 0 || status.staged.modified > 0 || status.staged.deleted > 0) {
      const staged = status.staged.added + status.staged.modified + status.staged.deleted
      changes.push(`<span class="git-staged" title="Staged changes">●${staged}</span>`)
    }
    if (status.unstaged.modified > 0 || status.unstaged.deleted > 0) {
      const unstaged = status.unstaged.modified + status.unstaged.deleted
      changes.push(`<span class="git-unstaged" title="Unstaged changes">○${unstaged}</span>`)
    }
    if (status.untracked > 0) {
      changes.push(`<span class="git-untracked" title="Untracked files">?${status.untracked}</span>`)
    }
    if (changes.length > 0) {
      parts.push(changes.join(' '))
    }

    // Lines added/removed
    if (status.linesAdded > 0 || status.linesRemoved > 0) {
      const lineParts: string[] = []
      if (status.linesAdded > 0) lineParts.push(`<span class="git-add">+${status.linesAdded}</span>`)
      if (status.linesRemoved > 0) lineParts.push(`<span class="git-remove">-${status.linesRemoved}</span>`)
      parts.push(lineParts.join(' '))
    }

    this.gitStatusEl.innerHTML = parts.join(' · ')
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
    // Store fibers for filtering
    this.openFibers = open
    this.closedFibers = closed

    // Clear search when loading new fibers
    this.searchInput.value = ''
    this.updateSearchClearVisibility()

    // Render using filter method (which handles empty state)
    this.renderFilteredFibers(open, closed)
  }

  private renderFiberItem(fiber: Fiber, closed = false): string {
    const statusIcon = fiber.status === 'active' ? '◐' : fiber.status === 'closed' ? '●' : '○'
    const kindClass = fiber.kind || 'task'
    const hasBody = !!fiber.body
    const hasReason = closed && !!fiber.reason
    const hasContent = hasBody || hasReason
    const contentClass = hasContent ? 'has-content' : ''

    // Full content (shown on expand)
    const bodyHtml = hasBody ? `<div class="fiber-body">${this.renderMarkdown(fiber.body!)}</div>` : ''
    const reasonHtml = hasReason ? `<div class="fiber-reason">${this.renderMarkdown(fiber.reason!)}</div>` : ''

    return `
      <li class="fiber-item ${kindClass} ${contentClass}" data-id="${fiber.id}">
        <div class="fiber-header">
          <span class="fiber-status">${statusIcon}</span>
          <span class="fiber-title">${this.escapeHtml(fiber.title)}</span>
          <span class="fiber-kind">${fiber.kind || 'task'}</span>
          <button class="handoff-btn" data-fiber-id="${fiber.id}" title="Hand off to Claude">↗</button>
        </div>
        <div class="fiber-content">
          ${bodyHtml}
          ${reasonHtml}
        </div>
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
