// TabbedPlansView.ts - Tabbed overlay for plannotator views across origins

import type { ServerOrigin } from '../state/types'

export class TabbedPlansView {
  private overlay: HTMLElement
  private tabBar: HTMLElement
  private iframeContainer: HTMLElement
  private currentOriginId: string | null = null
  private iframes: Map<string, HTMLIFrameElement> = new Map()
  private originPorts: Map<string, number> = new Map()

  constructor() {
    this.overlay = this.createOverlay()
    this.tabBar = this.overlay.querySelector('.plans-tab-bar')!
    this.iframeContainer = this.overlay.querySelector('.plans-iframe-container')!
    document.body.appendChild(this.overlay)
  }

  private createOverlay(): HTMLElement {
    const overlay = document.createElement('div')
    overlay.className = 'tabbed-plans-overlay'
    overlay.innerHTML = `
      <div class="plans-panel">
        <div class="plans-tab-bar"></div>
        <div class="plans-iframe-container">
          <div class="plans-empty-state">
            <p>No plannotator available</p>
            <p class="plans-empty-hint">Start plannotator on a machine with PLANNOTATOR_PORT set</p>
          </div>
        </div>
      </div>
    `
    return overlay
  }

  /**
   * Show the tabbed plans view with origins that have plannotatorPort
   */
  show(origins: ServerOrigin[]): void {
    // Filter to origins with plannotator port
    const plannotatorOrigins = origins.filter(o => o.plannotatorPort)

    // Clear existing tabs, iframes, and port mappings
    this.tabBar.innerHTML = ''
    this.iframes.clear()
    this.originPorts.clear()

    // Store port mappings
    for (const origin of plannotatorOrigins) {
      if (origin.plannotatorPort) {
        this.originPorts.set(origin.id, origin.plannotatorPort)
      }
    }

    if (plannotatorOrigins.length === 0) {
      // Show empty state
      this.iframeContainer.innerHTML = `
        <div class="plans-empty-state">
          <p>No plannotator available</p>
          <p class="plans-empty-hint">Start plannotator on a machine with PLANNOTATOR_PORT set</p>
        </div>
      `
      this.currentOriginId = null
    } else {
      // Clear empty state
      this.iframeContainer.innerHTML = ''

      // Create tabs and iframes for each origin
      for (const origin of plannotatorOrigins) {
        this.createTab(origin)
        this.createIframe(origin)
      }

      // Select first tab by default
      this.selectTab(plannotatorOrigins[0].id)
    }

    this.overlay.classList.add('visible')
  }

  private createTab(origin: ServerOrigin): void {
    const tab = document.createElement('button')
    tab.className = 'plans-tab'
    tab.dataset.originId = origin.id

    // Display name: "Local" for local, sshHost (e.g. "candide") for remote, fallback to hostname
    const displayName = origin.type === 'local' ? 'Local' : (origin.sshHost || origin.name)
    tab.textContent = displayName
    tab.title = `${displayName} - port ${origin.plannotatorPort}`

    tab.addEventListener('click', () => {
      this.selectTab(origin.id)
    })

    this.tabBar.appendChild(tab)
  }

  private createIframe(origin: ServerOrigin): void {
    const iframe = document.createElement('iframe')
    iframe.className = 'plans-iframe'
    iframe.dataset.originId = origin.id
    iframe.src = 'about:blank'
    iframe.style.display = 'none'

    this.iframes.set(origin.id, iframe)
    this.iframeContainer.appendChild(iframe)
  }

  private selectTab(originId: string): void {
    // Update tab active states
    const tabs = this.tabBar.querySelectorAll('.plans-tab')
    tabs.forEach(tab => {
      if ((tab as HTMLElement).dataset.originId === originId) {
        tab.classList.add('active')
      } else {
        tab.classList.remove('active')
      }
    })

    // Show selected iframe, hide others
    for (const [id, iframe] of this.iframes) {
      if (id === originId) {
        iframe.style.display = 'block'
        // Load iframe if not already loaded
        if (iframe.src === 'about:blank') {
          // Find the origin to get the port
          const port = this.getPortForOrigin(id)
          if (port) {
            iframe.src = `http://localhost:${port}`
          }
        }
      } else {
        iframe.style.display = 'none'
      }
    }

    this.currentOriginId = originId
  }

  private getPortForOrigin(originId: string): number | null {
    return this.originPorts.get(originId) ?? null
  }

  /**
   * Update the view with new origins (e.g., when an agent connects)
   */
  update(origins: ServerOrigin[]): void {
    if (!this.overlay.classList.contains('visible')) return

    const plannotatorOrigins = origins.filter(o => o.plannotatorPort)
    const currentIds = new Set(this.iframes.keys())
    const newIds = new Set(plannotatorOrigins.map(o => o.id))

    // Check if we need to rebuild
    const needsRebuild =
      currentIds.size !== newIds.size ||
      [...currentIds].some(id => !newIds.has(id))

    if (needsRebuild) {
      // Remember current selection
      const previousSelection = this.currentOriginId

      // Rebuild
      this.show(origins)

      // Restore selection if still valid
      if (previousSelection && newIds.has(previousSelection)) {
        this.selectTab(previousSelection)
      }
    }
  }

  hide(): void {
    this.overlay.classList.remove('visible')

    // Clear iframe sources to stop loading
    setTimeout(() => {
      if (!this.overlay.classList.contains('visible')) {
        for (const iframe of this.iframes.values()) {
          iframe.src = 'about:blank'
        }
      }
    }, 300)
  }

  isVisible(): boolean {
    return this.overlay.classList.contains('visible')
  }
}
