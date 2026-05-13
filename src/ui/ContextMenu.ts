// ContextMenu.ts - Right-click context menu for hex grid

export interface MenuItem {
  label: string
  action: () => void
  disabled?: boolean
  danger?: boolean
}

export class ContextMenu {
  private menu: HTMLElement
  private closeHandler: ((e: MouseEvent) => void) | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null

  constructor() {
    this.menu = this.createMenu()
    document.body.appendChild(this.menu)
  }

  private createMenu(): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'context-menu'
    menu.setAttribute('role', 'menu')
    // Give the container a stable accessible name so screen readers and
    // snapshot tools (agent-browser) announce it as "Context menu" with N
    // items, rather than dropping the unnamed wrapper and promoting the
    // menuitems to document-level orphans. This is the only context menu
    // in the app; we don't need to vary the label per invocation source.
    menu.setAttribute('aria-label', 'Context menu')
    menu.tabIndex = -1
    menu.style.cssText = `
      position: fixed;
      display: none;
      min-width: 160px;
      background: var(--bg-card, #EDE2CE);
      border: 1px solid var(--border, #8B7355);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 1000;
      padding: 4px 0;
      font-family: 'EB Garamond', Garamond, serif;
      font-size: 14px;
      outline: none;
    `
    return menu
  }

  show(x: number, y: number, items: MenuItem[]): void {
    // Clear previous items
    this.menu.innerHTML = ''

    for (const item of items) {
      const menuItem = document.createElement('div')
      menuItem.className = 'context-menu-item'
      menuItem.setAttribute('role', 'menuitem')
      menuItem.tabIndex = item.disabled ? -1 : 0
      if (item.disabled) menuItem.setAttribute('aria-disabled', 'true')
      menuItem.textContent = item.label

      const dangerColor = '#A03030'
      const normalColor = item.danger ? dangerColor : 'var(--text-primary, #2E2A26)'
      const hoverBg = item.danger ? dangerColor : 'var(--gold, #C49333)'

      menuItem.style.cssText = `
        padding: 8px 16px;
        cursor: ${item.disabled ? 'default' : 'pointer'};
        color: ${item.disabled ? 'var(--text-muted, #7A6F5C)' : normalColor};
        opacity: ${item.disabled ? '0.5' : '1'};
        transition: background 0.1s;
        outline: none;
      `

      if (!item.disabled) {
        const setActive = (): void => {
          menuItem.style.background = hoverBg
          menuItem.style.color = 'white'
        }
        const clearActive = (): void => {
          menuItem.style.background = ''
          menuItem.style.color = normalColor
        }
        menuItem.addEventListener('mouseenter', setActive)
        menuItem.addEventListener('mouseleave', clearActive)
        menuItem.addEventListener('focus', setActive)
        menuItem.addEventListener('blur', clearActive)
        menuItem.addEventListener('click', (e) => {
          e.stopPropagation()
          this.hide()
          item.action()
        })
      }

      this.menu.appendChild(menuItem)
    }

    // Position menu, keeping it on screen
    this.menu.style.display = 'block'
    const menuRect = this.menu.getBoundingClientRect()

    let posX = x
    let posY = y

    if (x + menuRect.width > window.innerWidth) {
      posX = window.innerWidth - menuRect.width - 8
    }
    if (y + menuRect.height > window.innerHeight) {
      posY = window.innerHeight - menuRect.height - 8
    }

    this.menu.style.left = `${posX}px`
    this.menu.style.top = `${posY}px`

    // Focus the first enabled item so keyboard navigation (arrow keys, Enter)
    // works immediately after right-click without requiring a mouse move.
    const enabledItems = Array.from(
      this.menu.querySelectorAll<HTMLElement>('.context-menu-item[tabindex="0"]'),
    )
    enabledItems[0]?.focus()

    // Add close handler (click outside to close, Escape to dismiss,
    // arrow keys to navigate, Enter/Space to activate the focused item).
    this.removeCloseHandler()
    this.closeHandler = (e: MouseEvent) => {
      if (!this.menu.contains(e.target as Node)) {
        this.hide()
      }
    }
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.hide()
        return
      }
      if (enabledItems.length === 0) return
      const active = document.activeElement as HTMLElement | null
      const idx = active ? enabledItems.indexOf(active) : -1
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        enabledItems[(idx + 1 + enabledItems.length) % enabledItems.length].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        enabledItems[(idx - 1 + enabledItems.length) % enabledItems.length].focus()
      } else if (e.key === 'Home') {
        e.preventDefault()
        enabledItems[0].focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        enabledItems[enabledItems.length - 1].focus()
      } else if ((e.key === 'Enter' || e.key === ' ') && idx >= 0) {
        e.preventDefault()
        enabledItems[idx].click()
      }
    }
    document.addEventListener('click', this.closeHandler)
    document.addEventListener('keydown', this.keyHandler)
  }

  private removeCloseHandler(): void {
    if (this.closeHandler) {
      document.removeEventListener('click', this.closeHandler)
      this.closeHandler = null
    }
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler)
      this.keyHandler = null
    }
  }

  hide(): void {
    this.menu.style.display = 'none'
    this.removeCloseHandler()
  }

  dispose(): void {
    this.hide()
    this.menu.remove()
  }
}
