// ClaimsDashboard.ts - Large panel for viewing claims DAG
// Handles postMessage bridge for inline annotation from the dashboard iframe

import type { City } from '../state/types'

const API_BASE = `http://${window.location.hostname}:4004`

export class ClaimsDashboard {
  private panel: HTMLElement
  private iframe: HTMLIFrameElement
  private closeBtn: HTMLElement
  private title: HTMLElement
  private loadingIndicator: HTMLElement
  private currentCity: City | null = null

  // Stored listener refs for HMR-safe cleanup
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private messageHandler: ((e: MessageEvent) => void) | null = null

  // Callback for send-to-worker (set by main.ts)
  onSendToWorker: ((city: City, annotations: any[]) => void) | null = null

  constructor() {
    this.panel = this.createPanel()
    this.iframe = this.panel.querySelector('iframe')!
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.title = this.panel.querySelector('h2')!
    this.loadingIndicator = this.panel.querySelector('.loading-indicator')!

    this.setupEventListeners()
    document.body.appendChild(this.panel)
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.className = 'claims-dashboard'
    panel.innerHTML = `
      <div class="claims-dashboard-header">
        <h2>Claims Dashboard</h2>
        <button class="close-btn">&times;</button>
      </div>
      <div class="loading-indicator">Loading claims...</div>
      <iframe src="about:blank" frameborder="0"></iframe>
    `
    return panel
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.hide())

    // Define escape handler (attached/detached dynamically to avoid HMR stacking)
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isVisible()) {
        this.hide()
      }
    }

    // postMessage handler for claims annotation bridge
    this.messageHandler = (e: MessageEvent) => {
      if (!e.data || !e.data.type) return
      // Only handle messages from our iframe
      if (e.source !== this.iframe.contentWindow) return

      switch (e.data.type) {
        case 'claims-annotation-save':
          this.handleAnnotationSave(e.data)
          break
        case 'claims-annotation-load':
          this.handleAnnotationLoad(e.data)
          break
        case 'claims-annotation-send':
          this.handleAnnotationSend(e.data)
          break
      }
    }
    window.addEventListener('message', this.messageHandler)
  }

  show(city: City, dashboardUrl: string): void {
    this.currentCity = city

    // Update title
    this.title.textContent = `Claims: ${city.name}`

    // Show loading
    this.loadingIndicator.style.display = 'flex'
    this.iframe.style.opacity = '0'

    // Set iframe src
    this.iframe.src = dashboardUrl

    // Hide loading when iframe loads
    this.iframe.onload = () => {
      this.loadingIndicator.style.display = 'none'
      this.iframe.style.opacity = '1'
    }

    // Attach escape listener and show panel
    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
    this.panel.classList.add('visible')
  }

  hide(): void {
    this.panel.classList.remove('visible')
    this.currentCity = null

    // Detach escape listener
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
    }

    // Clear iframe after animation
    setTimeout(() => {
      if (!this.isVisible()) {
        this.iframe.src = 'about:blank'
      }
    }, 300)
  }

  isVisible(): boolean {
    return this.panel.classList.contains('visible')
  }

  dispose(): void {
    this.hide()
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler)
    }
    this.panel.remove()
  }

  // ── postMessage handlers ──────────────────────────────────────────────

  private async handleAnnotationSave(data: {
    claimId: string
    claimTitle?: string
    selectedText?: string
    artifact?: string
    x?: number
    y?: number
    comment: string
  }): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: '',
          originId: this.currentCity?.originId || 'local',
          from: 0,
          to: 0,
          originalText: data.selectedText || '',
          contextBefore: '',
          contextAfter: '',
          comment: data.comment,
          claimId: data.claimId,
          claimTitle: data.claimTitle,
          selectedText: data.selectedText,
          artifact: data.artifact,
          x: data.x,
          y: data.y,
          isClaimAnnotation: true,
          isImageAnnotation: !!data.artifact,
        }),
      })

      if (!response.ok) {
        console.error('Failed to save claims annotation:', await response.text())
      }
    } catch (err) {
      console.error('Failed to save claims annotation:', err)
    }
  }

  private async handleAnnotationLoad(data: { claimId: string }): Promise<void> {
    try {
      const response = await fetch(
        `${API_BASE}/annotations?claimId=${encodeURIComponent(data.claimId)}`
      )
      if (!response.ok) return

      const result = await response.json()
      // Send annotations back to iframe
      this.iframe.contentWindow?.postMessage(
        {
          type: 'claims-annotation-loaded',
          claimId: data.claimId,
          annotations: result.annotations || [],
        },
        '*'
      )
    } catch (err) {
      console.error('Failed to load claims annotations:', err)
    }
  }

  private async handleAnnotationSend(data: { claimId: string; cityId: string }): Promise<void> {
    if (!this.currentCity) return

    // Fetch all claims annotations for this city
    try {
      const response = await fetch(
        `${API_BASE}/annotations?claimId=${encodeURIComponent(data.claimId)}`
      )
      if (!response.ok) return

      const result = await response.json()
      const annotations = result.annotations || []

      if (annotations.length === 0) return

      if (this.onSendToWorker) {
        this.onSendToWorker(this.currentCity, annotations)
      }
    } catch (err) {
      console.error('Failed to send claims annotations:', err)
    }
  }
}
