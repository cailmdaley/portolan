// ViewSwitcher.ts - Glass circular buttons for global view switching

export type GlobalView = 'map' | 'plots' | 'plans'

const icons: Record<GlobalView, string> = {
  map: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5">
    <polygon points="12,2 22,8 22,16 12,22 2,16 2,8"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`,

  plots: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5">
    <polyline points="4,18 4,6"/>
    <polyline points="4,18 20,18"/>
    <polyline points="6,14 10,10 14,12 18,6"/>
  </svg>`,

  plans: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5">
    <path d="M6,3 C4,3 4,5 4,5 L4,19 C4,21 6,21 6,21 L18,21 C20,21 20,19 20,19 L20,5 C20,3 18,3 18,3"/>
    <line x1="8" y1="9" x2="16" y2="9"/>
    <line x1="8" y1="13" x2="14" y2="13"/>
  </svg>`
}

const labels: Record<GlobalView, string> = {
  map: 'Map',
  plots: 'Plots',
  plans: 'Plans'
}

export class ViewSwitcher {
  private container: HTMLElement
  private buttons: Map<GlobalView, HTMLElement> = new Map()
  private currentView: GlobalView = 'map'
  private onViewChange: (view: GlobalView) => void

  constructor(onViewChange: (view: GlobalView) => void) {
    this.onViewChange = onViewChange
    this.container = this.createContainer()
    document.body.appendChild(this.container)
  }

  private createContainer(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'view-switcher'

    const views: GlobalView[] = ['map', 'plots', 'plans']

    for (const view of views) {
      const btn = document.createElement('button')
      btn.className = `view-btn${view === this.currentView ? ' active' : ''}`
      btn.innerHTML = icons[view]
      btn.title = labels[view]
      btn.setAttribute('aria-label', labels[view])

      btn.addEventListener('click', () => {
        if (view !== this.currentView) {
          this.setActive(view)
          this.onViewChange(view)
        }
      })

      this.buttons.set(view, btn)
      container.appendChild(btn)
    }

    return container
  }

  setActive(view: GlobalView): void {
    this.currentView = view

    for (const [v, btn] of this.buttons) {
      if (v === view) {
        btn.classList.add('active')
      } else {
        btn.classList.remove('active')
      }
    }
  }
}
