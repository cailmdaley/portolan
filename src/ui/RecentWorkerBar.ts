import type { City, Session } from '../state/types'

interface RecentWorkerBarOptions {
  onSelectWorker: (session: Session) => void
  onFileClick: (fullPath: string, originId: string, workerId: string) => void
}

/**
 * A row of tiny bird sprites perched on an invisible wire at the top of the screen.
 * Shows the 5 most recently active workers that aren't currently working.
 * Hover reveals name; click focuses camera + Kitty tab.
 */
export class RecentWorkerBar {
  private readonly onSelectWorker: (session: Session) => void
  private readonly onFileClick: (fullPath: string, originId: string, workerId: string) => void
  private readonly container: HTMLDivElement
  private readonly wire: HTMLDivElement
  private cityNameById = new Map<string, string>()
  private currentBirds: HTMLElement[] = []
  private hoverRequestId = 0

  constructor(options: RecentWorkerBarOptions) {
    this.onSelectWorker = options.onSelectWorker
    this.onFileClick = options.onFileClick
    this.injectStyles()

    this.container = document.createElement('div')
    this.container.className = 'rwb-bar'
    this.container.setAttribute('role', 'navigation')
    this.container.setAttribute('aria-label', 'Recent workers')

    this.wire = document.createElement('div')
    this.wire.className = 'rwb-wire'

    this.container.appendChild(this.wire)
    document.body.appendChild(this.container)

    const activate = (target: EventTarget | null): void => {
      const perch = (target as HTMLElement | null)?.closest<HTMLElement>('.rwb-perch')
      if (!perch) return
      const sessionId = perch.dataset.sessionId
      if (!sessionId) return
      const session = (perch as any).__session as Session | undefined
      if (session) this.onSelectWorker(session)
    }

    this.container.addEventListener('click', (event) => activate(event.target))

    // Keyboard parity for role="button" perches: Enter and Space activate.
    this.container.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const perch = (event.target as HTMLElement | null)?.closest<HTMLElement>('.rwb-perch')
      if (!perch) return
      event.preventDefault()
      activate(event.target)
    })
  }

  /** Call on every state update with current cities and sessions. */
  update(cities: City[], sessions: Session[]): void {
    this.cityNameById = new Map(cities.map(c => [c.id, c.name]))

    // Filter: not currently working, has lastActivity
    const idle = sessions
      .filter(s => s.status !== 'working' && s.lastActivity)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 5)

    this.reconcile(idle)
  }

  /**
   * Diff-based update: keep existing birds, fade out departing ones,
   * only land-animate genuinely new arrivals, smoothly update opacity/order.
   */
  private reconcile(sessions: Session[]): void {
    const nextIds = new Set(sessions.map(s => s.id))
    const existingById = new Map(this.currentBirds.map(el => [el.dataset.sessionId!, el]))

    if (sessions.length === 0) {
      // Fade out all
      for (const bird of this.currentBirds) {
        this.fadeOut(bird)
      }
      this.currentBirds = []
      this.container.classList.add('rwb-empty')
      return
    }
    this.container.classList.remove('rwb-empty')

    // Fade out departing birds
    for (const bird of this.currentBirds) {
      if (!nextIds.has(bird.dataset.sessionId!)) {
        this.fadeOut(bird)
      }
    }

    // Build new list, reusing existing elements
    const nextBirds: HTMLElement[] = []
    const total = sessions.length

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i]
      const existing = existingById.get(session.id)
      const opacity = 0.25 + (((total - 1 - i) / Math.max(total - 1, 1)) * 0.45)

      if (existing) {
        // Update opacity and order smoothly (CSS transition handles it)
        existing.style.opacity = String(opacity)
        existing.style.order = String(i)
        ;(existing as any).__session = session
        nextBirds.push(existing)
      } else {
        // New bird — create with landing animation
        const perch = this.createPerch(session, i, total)
        perch.style.order = String(i)
        this.container.appendChild(perch)
        nextBirds.push(perch)
      }
    }

    this.currentBirds = nextBirds
  }

  /** Fade out and remove after transition. */
  private fadeOut(el: HTMLElement): void {
    el.style.opacity = '0'
    el.style.transform = 'translateY(-6px)'
    el.addEventListener('transitionend', () => el.remove(), { once: true })
    // Safety: remove after 400ms even if transitionend doesn't fire
    setTimeout(() => { if (el.parentNode) el.remove() }, 400)
  }

  private createPerch(session: Session, index: number, total: number): HTMLElement {
    const perch = document.createElement('div')
    perch.className = 'rwb-perch rwb-arriving'
    perch.dataset.sessionId = session.id
    ;(perch as any).__session = session

    // Label the perch for screen readers and a11y-tree agents: "Recent worker
    // <name> on <city>". Falls back to just the name when the session has no
    // associated city (edge case on freshly-discovered workers).
    const perchCityName = session.cityId ? this.cityNameById.get(session.cityId) : null
    // Full tmux session name for a11y; `session.name` is the elided chip form.
    const fullName = session.tmuxSession || session.name
    perch.setAttribute('role', 'button')
    perch.setAttribute('tabindex', '0')
    perch.setAttribute(
      'aria-label',
      perchCityName
        ? `Recent worker ${fullName} on ${perchCityName}`
        : `Recent worker ${fullName}`,
    )

    // Opacity cascade: most recent = 0.7, oldest = 0.25
    const opacity = 0.25 + (((total - 1 - index) / Math.max(total - 1, 1)) * 0.45)
    perch.style.opacity = String(opacity)

    // Deterministic slight rotation from name hash
    const angle = this.nameToAngle(session.name)
    perch.style.animationDelay = `${index * 60}ms`

    const bird = document.createElement('img')
    bird.className = 'rwb-bird'
    bird.src = '/cursors/bird-small.png'
    bird.alt = ''
    bird.draggable = false
    bird.style.transform = `rotate(${angle}deg)`

    const name = document.createElement('span')
    name.className = 'rwb-name'
    name.textContent = session.name

    const cityName = session.cityId ? this.cityNameById.get(session.cityId) : null
    const tooltip = document.createElement('div')
    tooltip.className = 'rwb-tooltip'
    if (cityName) {
      const cityEl = document.createElement('span')
      cityEl.className = 'rwb-tooltip-city'
      cityEl.textContent = cityName
      tooltip.appendChild(cityEl)
    }

    const filesEl = document.createElement('div')
    filesEl.className = 'rwb-tooltip-files'
    tooltip.appendChild(filesEl)

    perch.append(bird, name, tooltip)

    // Mirror hover behaviour for keyboard focus: keyboard users tab to a perch
    // and the tooltip otherwise stays opacity:0, hiding the recent files. The
    // CSS uses :hover, :focus-within for visibility; this mirrors the loader
    // side so files actually populate on focus too.
    const showFiles = (): void => { this.loadRecentFiles(session, filesEl) }
    const hideFiles = (): void => {
      this.hoverRequestId++
      filesEl.innerHTML = ''
    }
    perch.addEventListener('mouseenter', showFiles)
    perch.addEventListener('mouseleave', hideFiles)
    perch.addEventListener('focusin', showFiles)
    perch.addEventListener('focusout', (e) => {
      // Don't tear down when focus moves between children of the perch
      // (perch → file item, file item → file item). Only on real exit.
      const next = e.relatedTarget as Node | null
      if (next && perch.contains(next)) return
      hideFiles()
    })

    return perch
  }

  private async loadRecentFiles(session: Session, container: HTMLElement): Promise<void> {
    const requestId = ++this.hoverRequestId
    try {
      const res = await fetch(
        `http://${window.location.hostname}:4004/recent-files?sessionId=${encodeURIComponent(session.id)}&limit=4`
      )
      if (!res.ok || requestId !== this.hoverRequestId) return
      const data = await res.json() as { files?: Array<{ basename: string; fullPath: string; toolName: string }> }
      if (requestId !== this.hoverRequestId) return
      const files = Array.isArray(data.files) ? data.files.slice(0, 4) : []
      if (files.length === 0) return
      container.innerHTML = ''
      for (const f of files) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'rwb-file-item'
        item.title = f.fullPath
        item.textContent = f.basename
        // Visible text is the basename; the action is "open the file in vellum".
        // Without an aria-label, screen readers announce "FrontendStateSync.ts,
        // button" with no hint that activation opens the file. Match the HUD
        // file tree label vocabulary.
        item.setAttribute('aria-label', `Open ${f.basename}`)
        item.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          this.onFileClick(f.fullPath, session.originId, session.id)
        })
        container.appendChild(item)
      }
    } catch {
      // Silently ignore — tooltip just won't show files
    }
  }

  /** Small deterministic angle from session name, range [-10, 10]. */
  private nameToAngle(name: string): number {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
    }
    return ((hash % 21) - 10) // -10 to +10 degrees
  }

  dispose(): void {
    this.container.remove()
  }

  private injectStyles(): void {
    if (document.getElementById('rwb-styles')) return

    const style = document.createElement('style')
    style.id = 'rwb-styles'
    style.textContent = `
      .rwb-bar {
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: flex-start;
        gap: 32px;
        z-index: 50;
        pointer-events: none;
        padding: 0 16px;
        height: 36px;
      }

      .rwb-bar.rwb-empty {
        display: none;
      }

      /* The wire — a faint line the birds perch on */
      .rwb-wire {
        position: absolute;
        top: 16px;
        left: -8px;
        right: -8px;
        height: 1px;
        background: var(--ink-faded, #7A7068);
        opacity: 0.15;
      }

      @keyframes rwb-land {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: var(--rwb-target-opacity, 0.5);
          transform: translateY(0);
        }
      }

      .rwb-perch {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        cursor: pointer;
        pointer-events: auto;
        transition: opacity 300ms ease, transform 300ms ease;
      }

      .rwb-perch.rwb-arriving {
        animation: rwb-land 300ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
      }

      .rwb-perch:hover,
      .rwb-perch:focus-visible {
        opacity: 1 !important;
      }

      /* Quiet, antiquarian focus ring — keyboard-only via :focus-visible */
      .rwb-perch:focus { outline: none; }
      .rwb-perch:focus-visible {
        outline: 1px dashed var(--ink-faded, #7A7068);
        outline-offset: 4px;
        border-radius: 2px;
      }

      .rwb-bird {
        width: 16px;
        height: 16px;
        transition: transform 200ms ease;
        /* Tint to verdigris-ish */
        filter: sepia(1) saturate(2) hue-rotate(100deg) brightness(0.45);
      }

      .rwb-perch:hover .rwb-bird,
      .rwb-perch:focus-within .rwb-bird {
        transform: rotate(0deg) scale(1.15) !important;
        filter: sepia(1) saturate(2) hue-rotate(100deg) brightness(0.35);
      }

      /* Worker name below bird */
      .rwb-name {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 11px;
        color: var(--ink-faded, #7A7068);
        letter-spacing: 0.03em;
        margin-top: 2px;
        white-space: nowrap;
        transition: color 150ms ease;
      }

      .rwb-perch:hover .rwb-name,
      .rwb-perch:focus-within .rwb-name {
        color: var(--ink-dark, #2A2520);
      }

      /* Tooltip on hover */
      .rwb-tooltip {
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%) translateY(0px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 150ms ease, transform 150ms ease;
        white-space: nowrap;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 6px 0 4px;
      }

      .rwb-perch:hover .rwb-tooltip,
      .rwb-perch:focus-within .rwb-tooltip {
        pointer-events: auto;
        opacity: 1;
        transform: translateX(-50%) translateY(2px);
      }

      .rwb-tooltip-city {
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 12.5px;
        color: var(--ink-faded, #7A7068);
        font-style: italic;
      }

      .rwb-tooltip-files {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
      }

      .rwb-tooltip-files:empty {
        display: none;
      }

      .rwb-file-item {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10.5px;
        color: var(--ink-faded, #7A7068);
        letter-spacing: 0.02em;
        opacity: 0.7;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        transition: color 100ms ease, opacity 100ms ease;
      }

      .rwb-file-item:hover {
        color: var(--ink-dark, #2A2520);
        opacity: 1;
      }
    `
    document.head.appendChild(style)
  }
}
