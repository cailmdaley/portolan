// ClaimsDashboard.ts - Large panel for viewing claims DAG

import type { City } from '../state/types'

export class ClaimsDashboard {
  private panel: HTMLElement
  private iframe: HTMLIFrameElement
  private closeBtn: HTMLElement
  private title: HTMLElement
  private loadingIndicator: HTMLElement

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

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible()) {
        this.hide()
      }
    })
  }

  show(city: City, dashboardUrl: string): void {
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

    // Show panel
    this.panel.classList.add('visible')
  }

  hide(): void {
    this.panel.classList.remove('visible')

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
}
