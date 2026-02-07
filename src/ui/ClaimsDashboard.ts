// Handles postMessage bridge for inline annotation from the dashboard iframe

import type { City } from '../state/types'
import { showToast } from './utils'
import { showWorkerPicker, type WorkerInfo } from './WorkerPicker'

const API_BASE = `http://${window.location.hostname}:4004`

export class ClaimsDashboard {
  private panel: HTMLElement
  private iframe: HTMLIFrameElement
  private closeBtn: HTMLElement
  private sendAllBtn: HTMLElement
  private title: HTMLElement
  private loadingIndicator: HTMLElement
  private currentCity: City | null = null
  private loadTimeout: ReturnType<typeof setTimeout> | null = null

  // Stored listener refs for HMR-safe cleanup
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private messageHandler: ((e: MessageEvent) => void) | null = null

  // Callback for getting available workers (set by main.ts)
  private onGetWorkers: ((city: City) => WorkerInfo[]) | null = null

  constructor() {
    this.panel = this.createPanel()
    this.iframe = this.panel.querySelector('iframe')!
    this.closeBtn = this.panel.querySelector('.close-btn')!
    this.sendAllBtn = this.panel.querySelector('.send-all-btn')!
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
        <div class="claims-dashboard-actions">
          <button class="send-all-btn" title="Send all annotations to worker">Send All to Worker</button>
          <button class="close-btn">&times;</button>
        </div>
      </div>
      <div class="loading-indicator">Loading claims...</div>
      <iframe src="about:blank" frameborder="0"></iframe>
    `
    return panel
  }

  private setupEventListeners(): void {
    this.closeBtn.addEventListener('click', () => this.hide())
    this.sendAllBtn.addEventListener('click', () => this.handleSendAll())

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
        case 'claims-annotation-delete':
          this.handleAnnotationDelete(e.data)
          break
        case 'claims-annotation-promote':
          this.handleAnnotationPromote(e.data)
          break
      }
    }
    window.addEventListener('message', this.messageHandler)
  }

  show(city: City, dashboardUrl: string): void {
    this.currentCity = city
    this.title.textContent = `Claims: ${city.name}`

    this.loadingIndicator.textContent = 'Loading claims...'
    this.loadingIndicator.classList.remove('error')
    this.loadingIndicator.style.display = 'flex'
    this.iframe.style.opacity = '0'
    this.iframe.src = dashboardUrl

    // Clear any previous timeout
    if (this.loadTimeout) clearTimeout(this.loadTimeout)

    this.iframe.onload = () => {
      if (this.loadTimeout) clearTimeout(this.loadTimeout)
      this.loadingIndicator.style.display = 'none'
      this.iframe.style.opacity = '1'
    }

    this.iframe.onerror = () => {
      if (this.loadTimeout) clearTimeout(this.loadTimeout)
      this.showLoadError('Failed to load claims dashboard')
    }

    // Timeout after 15s for remote dashboards (SSH can be slow)
    this.loadTimeout = setTimeout(() => {
      if (this.iframe.style.opacity === '0') {
        this.showLoadError('Dashboard load timed out')
      }
    }, 15000)

    if (this.escapeHandler) {
      document.addEventListener('keydown', this.escapeHandler)
    }
    this.panel.classList.add('visible')
  }

  private showLoadError(message: string): void {
    this.loadingIndicator.textContent = message
    this.loadingIndicator.classList.add('error')
    this.loadingIndicator.style.display = 'flex'
    this.iframe.style.opacity = '0'
  }

  hide(): void {
    this.panel.classList.remove('visible')
    this.currentCity = null

    if (this.loadTimeout) {
      clearTimeout(this.loadTimeout)
      this.loadTimeout = null
    }

    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler)
    }

    // Clear iframe after CSS transition completes
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
    const response = await this.fetchApi('/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originId: this.currentCity?.originId || 'local',
        comment: data.comment,
        isClaimAnnotation: true,
        claimId: data.claimId,
        claimTitle: data.claimTitle,
        selectedText: data.selectedText,
        artifact: data.artifact,
        x: data.x,
        y: data.y,
        isImageAnnotation: !!data.artifact,
      }),
    })

    if (!response) return

    showToast('Annotation saved', 'success', 2000)
    // Reload so permanent markers replace temporary pins
    this.handleAnnotationLoad({ claimId: data.claimId })
  }

  private async handleAnnotationLoad(data: { claimId: string }): Promise<void> {
    const response = await this.fetchApi(
      `/annotations?claimId=${encodeURIComponent(data.claimId)}`
    )
    if (!response) return

    const result = await response.json()
    this.iframe.contentWindow?.postMessage(
      {
        type: 'claims-annotation-loaded',
        claimId: data.claimId,
        annotations: result.annotations || [],
      },
      '*'
    )
  }

  private async handleAnnotationSend(data: { claimId: string; cityId: string }): Promise<void> {
    await this.fetchAnnotationsAndPickWorker(
      `/annotations?claimId=${encodeURIComponent(data.claimId)}`
    )
  }

  private async handleAnnotationDelete(data: { annotationId: string; claimId: string }): Promise<void> {
    const response = await this.fetchApi(
      `/annotations/${encodeURIComponent(data.annotationId)}`,
      { method: 'DELETE' }
    )

    if (!response) return

    showToast('Annotation deleted', 'success', 2000)
    this.handleAnnotationLoad({ claimId: data.claimId })
  }

  private async handleAnnotationPromote(data: {
    claimId: string
    annotationId?: string
    comment: string
  }): Promise<void> {
    if (!this.currentCity) return

    const response = await this.fetchApi('/promote-to-felt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimId: data.claimId,
        comment: data.comment,
        cityId: this.currentCity.id,
      }),
    })

    if (response) {
      showToast('Promoted to felt', 'success', 2000)
      this.iframe.contentWindow?.postMessage(
        {
          type: 'claims-annotation-promoted',
          claimId: data.claimId,
          annotationId: data.annotationId,
        },
        '*'
      )
    }
  }

  private async handleSendAll(): Promise<void> {
    await this.fetchAnnotationsAndPickWorker('/annotations?claims=true', 'No annotations to send')
  }

  // ── Shared fetch helpers ──────────────────────────────────────────────

  /** Fetch from API with error handling and toast. Returns Response on success, null on failure. */
  private async fetchApi(path: string, init?: RequestInit): Promise<Response | null> {
    try {
      const response = await fetch(`${API_BASE}${path}`, init)
      if (!response.ok) {
        console.error(`API error ${path}:`, await response.text())
        showToast(`Request failed`, 'error')
        return null
      }
      return response
    } catch (err) {
      console.error(`API error ${path}:`, err)
      showToast(`Request failed`, 'error')
      return null
    }
  }

  /** Fetch annotations from a query path and show the worker picker if results exist. */
  private async fetchAnnotationsAndPickWorker(
    queryPath: string,
    emptyMessage?: string
  ): Promise<void> {
    if (!this.currentCity) return

    const response = await this.fetchApi(queryPath)
    if (!response) return

    const result = await response.json()
    const annotations = result.annotations || []

    if (annotations.length === 0) {
      if (emptyMessage) showToast(emptyMessage, 'error', 2000)
      return
    }

    this.showWorkerPickerUI(annotations)
  }

  // ── Worker picker ──────────────────────────────────────────────────────

  setOnGetWorkers(fn: (city: City) => WorkerInfo[]): void {
    this.onGetWorkers = fn
  }

  private showWorkerPickerUI(annotations: any[]): void {
    if (!this.currentCity) return

    const workers = this.onGetWorkers ? this.onGetWorkers(this.currentCity) : []

    showWorkerPicker(workers, annotations.length, {
      onSelectWorker: (workerId) => this.sendClaimsToWorker(annotations, workerId),
      onNewWorker: () => this.sendClaimsToWorker(annotations, undefined, true),
    })
  }

  private async sendClaimsToWorker(
    annotations: any[],
    workerId?: string,
    createNew?: boolean
  ): Promise<void> {
    if (!this.currentCity) return

    const response = await this.fetchApi('/send-annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId,
        createNewWorker: createNew,
        filePath: this.currentCity.path + '/claims', // city path (used for new worker creation)
        originId: this.currentCity.originId,
        annotations,
        cityName: this.currentCity.name,
        isClaimsSend: true,
      }),
    })

    if (response) {
      showToast('Annotations sent to worker', 'success')
    }
  }
}
