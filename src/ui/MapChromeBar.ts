import type { City, Session } from '../state/types'

/**
 * MapChromeBar — Stage H of constitution-portolan-navigation-layer.
 *
 * The only persistent UI on top of the map. Replaces the two pre-Stage-H
 * top-of-map widgets (`KanbanLaunchButton` + `RecentWorkerBar`) with a
 * single thin Civ-style chrome bar carrying:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ▣ Vellum  │  V  K  F  │  🐦 wkr1  🐦 wkr2  …  │  3 working · 2 review │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 *   - launch button (left): opens the last vellum view, falls back to
 *     narrative-on-focused-city. Stage J will widen "last view" to the URL
 *     fragment; for now the host hands us the focused-city → narrative
 *     resolver.
 *   - V / K / F mode chips: mirror the `v` / `k` / `/` hotkeys. The chip
 *     for the currently-active vellum tab lights up via `syncMode()`.
 *   - worker birds: same data feed RecentWorkerBar consumed (idle workers,
 *     ranked by `lastActivity`), rendered horizontally in the bar with names
 *     below the birds, hover → recent files, and click → kitty focus.
 *   - activity glance: live counts on the right — N working sessions,
 *     plus an awaiting-review chip on the K letter when the kanban poll
 *     turns up cards in `awaiting-review`.
 *
 * Vanilla TS, matches the rest of `src/ui/`. Vellum's modal covers it
 * (z-index 1000 vs our 50), which is the same disappear-under-modal
 * behaviour the predecessor widgets had — vellum's own tabs handle
 * mode flips while the modal is open.
 */

interface MapChromeBarOptions {
  /** Launch button (▣ Vellum). Pre-Stage-J: open narrative on focused
   *  city. Post-Stage-J: open the last URL-encoded view. */
  onOpenLastView: () => void
  /** V chip — narrative tab. Same semantics as the `v` hotkey: open /
   *  flip-to / close. */
  onOpenNarrative: () => void
  /** K chip — kanban tab. Same semantics as the `k` hotkey. */
  onOpenKanban: () => void
  /** F chip — find tab. Same semantics as the `/` hotkey (opens at
   *  city scope when there is one, global otherwise). */
  onOpenFind: () => void
  /** Bird click — focus camera + kitty tab on this worker. */
  onSelectWorker: (session: Session) => void
  /** Worker perch hover — show the shared recent-file tooltip. */
  onWorkerHoverStart?: (session: Session, anchor: { x: number; y: number }) => void
  /** Worker perch hover end — hide the shared recent-file tooltip. */
  onWorkerHoverEnd?: () => void
  /** Override fetch base for the awaiting-review badge poll. */
  apiBase?: string
  /** Suppress the badge poll while vellum is showing the kanban tab — the
   *  embedded grid renders fresh counts there. Mirrors KanbanLaunchButton's
   *  pre-Stage-H behaviour. */
  isKanbanModalOpen?: () => boolean
  /** Scope the K-chip badge to the same kanban view the K chip would open.
   *  Null means global; a city id means `/kanban?cityId=<id>`. */
  getKanbanBadgeCityId?: () => string | null
  /** Override poll interval (ms). Default 30s. */
  pollIntervalMs?: number
}

type Mode = 'narrative' | 'kanban' | 'find'

export class MapChromeBar {
  private readonly opts: MapChromeBarOptions
  private readonly apiBase: string
  private readonly pollIntervalMs: number

  private readonly container: HTMLDivElement
  private readonly launchBtn: HTMLButtonElement
  private readonly chipNarrative: HTMLButtonElement
  private readonly chipKanban: HTMLButtonElement
  private readonly chipFind: HTMLButtonElement
  private readonly kanbanBadge: HTMLSpanElement
  private readonly cityPlaque: HTMLDivElement
  private readonly cityPlaqueName: HTMLSpanElement
  private readonly birdsRow: HTMLDivElement
  private readonly glance: HTMLDivElement
  private readonly glanceWorking: HTMLSpanElement

  private cityNameById = new Map<string, string>()
  private currentBirds: HTMLElement[] = []
  private pollTimer: number | null = null
  private lastBadgeValue: number | null = null

  constructor(options: MapChromeBarOptions) {
    this.opts = options
    this.apiBase = options.apiBase
      ?? `http://${window.location.hostname}:4004`
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000

    this.injectStyles()

    this.container = document.createElement('div')
    this.container.className = 'mcb-bar'
    this.container.setAttribute('role', 'navigation')
    this.container.setAttribute('aria-label', 'Map chrome — vellum + workers')

    this.launchBtn = this.makeLaunchButton()
    const chipsGroup = document.createElement('div')
    chipsGroup.className = 'mcb-chips'
    chipsGroup.setAttribute('role', 'group')
    chipsGroup.setAttribute('aria-label', 'Vellum tab')
    this.chipNarrative = this.makeChip('V', 'narrative', 'Open narrative (v)', this.opts.onOpenNarrative)
    this.chipKanban = this.makeChip('K', 'kanban', 'Open kanban (k)', this.opts.onOpenKanban)
    this.chipFind = this.makeChip('F', 'find', 'Open find (/)', this.opts.onOpenFind)
    // Awaiting-review badge — perched on the K chip (the only chip whose
    // count is meaningful at rest; narrative + find are stateless).
    this.kanbanBadge = document.createElement('span')
    this.kanbanBadge.className = 'mcb-chip-badge'
    this.kanbanBadge.style.display = 'none'
    this.chipKanban.appendChild(this.kanbanBadge)
    chipsGroup.append(this.chipNarrative, this.chipKanban, this.chipFind)

    const sep1 = this.makeSeparator()

    this.cityPlaque = document.createElement('div')
    this.cityPlaque.className = 'mcb-city'
    this.cityPlaque.setAttribute('aria-live', 'polite')
    this.cityPlaqueName = document.createElement('span')
    this.cityPlaqueName.className = 'mcb-city-name'
    this.cityPlaque.append(this.cityPlaqueName)
    this.syncFocusedCity(null)

    const sepCity = this.makeSeparator()

    this.birdsRow = document.createElement('div')
    this.birdsRow.className = 'mcb-birds'
    this.birdsRow.setAttribute('role', 'list')
    this.birdsRow.setAttribute('aria-label', 'Recent workers')
    // Bird click delegation (Enter/Space keyboard parity for role="button"
    // perches; same pattern as legacy RecentWorkerBar).
    const activatePerch = (target: EventTarget | null): void => {
      const perch = (target as HTMLElement | null)?.closest<HTMLElement>('.mcb-perch')
      if (!perch) return
      const session = (perch as unknown as { __session?: Session }).__session
      if (session) this.opts.onSelectWorker(session)
    }
    this.birdsRow.addEventListener('click', (event) => activatePerch(event.target))
    this.birdsRow.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const perch = (event.target as HTMLElement | null)?.closest<HTMLElement>('.mcb-perch')
      if (!perch) return
      event.preventDefault()
      activatePerch(event.target)
    })

    const sep2 = this.makeSeparator()

    this.glance = document.createElement('div')
    this.glance.className = 'mcb-glance'
    this.glance.setAttribute('aria-live', 'polite')
    this.glanceWorking = document.createElement('span')
    this.glanceWorking.className = 'mcb-glance-working'
    this.glance.appendChild(this.glanceWorking)
    this.refreshGlance(0)

    this.container.append(this.launchBtn, chipsGroup, sep1, this.cityPlaque, sepCity, this.birdsRow, sep2, this.glance)
    document.body.appendChild(this.container)

    void this.refreshAwaitingReview()
    this.startPolling()
  }

  /** Push the current vellum tab so the matching chip lights up. Pass
   *  `null` when vellum is closed (no chip highlights). */
  syncMode(mode: Mode | null): void {
    for (const [chip, m] of [
      [this.chipNarrative, 'narrative'],
      [this.chipKanban, 'kanban'],
      [this.chipFind, 'find'],
    ] as const) {
      const active = mode === m
      chip.classList.toggle('is-active', active)
      chip.setAttribute('aria-pressed', String(active))
    }
  }

  /** Call on every state update with current cities + sessions. Mirrors
   *  the contract `RecentWorkerBar.update` exposed; we additionally
   *  refresh the working-count glance from the same input. */
  update(cities: City[], sessions: Session[]): void {
    this.cityNameById = new Map(cities.map((c) => [c.id, c.name]))

    const recent = sessions
      .filter((s) => s.lastActivity)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 6)
    this.reconcileBirds(recent)

    const working = sessions.filter((s) => s.status === 'working').length
    this.refreshGlance(working)
  }

  /** Manual badge refresh — called after an open/close on kanban so the
   *  count is fresh without waiting for the poll. */
  refreshSoon(): void {
    void this.refreshAwaitingReview()
  }

  syncFocusedCity(city: City | null): void {
    if (city) {
      this.cityPlaque.classList.remove('mcb-city-empty')
      this.cityPlaqueName.textContent = city.name
      this.cityPlaque.removeAttribute('title')
      this.cityPlaque.setAttribute('aria-label', `Selected city ${city.name}`)
    } else {
      this.cityPlaque.classList.add('mcb-city-empty')
      this.cityPlaqueName.textContent = 'world map'
      this.cityPlaque.removeAttribute('title')
      this.cityPlaque.setAttribute('aria-label', 'No selected city')
    }
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.container.remove()
  }

  // ───────────────────────────── internals ─────────────────────────────

  private makeLaunchButton(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mcb-launch'
    btn.setAttribute('aria-label', 'Open vellum (last view)')
    btn.title = 'Open vellum'
    // An open-book glyph — the reading surface. Keeps the button's
    // semantic "vellum" in icon form even when text is hidden at narrow
    // widths (no narrow-width clamp today, but the SVG carries the
    // meaning regardless of label rendering).
    const icon = document.createElement('span')
    icon.className = 'mcb-launch-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M2 3.5 C 4 2.5, 6.5 2.5, 8 3.5 C 9.5 2.5, 12 2.5, 14 3.5 L 14 12.5 C 12 11.5, 9.5 11.5, 8 12.5 C 6.5 11.5, 4 11.5, 2 12.5 Z" />'
      + '<path d="M8 3.5 L 8 12.5" />'
      + '</svg>'
    const label = document.createElement('span')
    label.className = 'mcb-launch-label'
    label.textContent = 'vellum'
    btn.append(icon, label)
    btn.addEventListener('click', () => this.opts.onOpenLastView())
    return btn
  }

  private makeChip(
    letter: string,
    mode: Mode,
    aria: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'mcb-chip'
    chip.dataset.mode = mode
    chip.textContent = letter
    chip.setAttribute('aria-label', aria)
    chip.setAttribute('aria-pressed', 'false')
    chip.title = aria
    chip.addEventListener('click', () => onClick())
    return chip
  }

  private makeSeparator(): HTMLSpanElement {
    const sep = document.createElement('span')
    sep.className = 'mcb-sep'
    sep.setAttribute('aria-hidden', 'true')
    return sep
  }

  private refreshGlance(workingCount: number): void {
    if (workingCount > 0) {
      this.glanceWorking.textContent = `${workingCount} working`
      this.glance.classList.remove('mcb-empty')
    } else {
      this.glanceWorking.textContent = ''
      this.glance.classList.add('mcb-empty')
    }
  }

  // ───────────── worker birds ─────────────

  private reconcileBirds(sessions: Session[]): void {
    const nextIds = new Set(sessions.map((s) => s.id))
    const existingById = new Map(
      this.currentBirds.map((el) => [el.dataset.sessionId!, el]),
    )

    if (sessions.length === 0) {
      for (const bird of this.currentBirds) this.fadeOut(bird)
      this.currentBirds = []
      this.birdsRow.classList.add('mcb-birds-empty')
      return
    }
    this.birdsRow.classList.remove('mcb-birds-empty')

    for (const bird of this.currentBirds) {
      if (!nextIds.has(bird.dataset.sessionId!)) this.fadeOut(bird)
    }

    const nextBirds: HTMLElement[] = []
    const total = sessions.length
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i]
      const existing = existingById.get(session.id)
      const opacity = 0.32 + ((total - 1 - i) / Math.max(total - 1, 1)) * 0.45
      if (existing) {
        existing.style.opacity = String(opacity)
        existing.style.order = String(i)
        ;(existing as unknown as { __session: Session }).__session = session
        // Keep aria-label fresh — city name might have changed.
        const cityName = session.cityId ? this.cityNameById.get(session.cityId) : null
        const fullName = session.tmuxSession || session.name
        const displayName = this.workerDisplayName(session)
        existing.setAttribute(
          'aria-label',
          cityName ? `Recent worker ${fullName} on ${cityName}` : `Recent worker ${fullName}`,
        )
        existing.classList.toggle('is-working', session.status === 'working')
        existing.removeAttribute('title')
        const label = existing.querySelector<HTMLElement>('.mcb-worker-name')
        if (label) label.textContent = displayName
        nextBirds.push(existing)
      } else {
        const perch = this.createPerch(session, i, total)
        perch.style.order = String(i)
        this.birdsRow.appendChild(perch)
        nextBirds.push(perch)
      }
    }
    this.currentBirds = nextBirds
  }

  private fadeOut(el: HTMLElement): void {
    el.style.opacity = '0'
    el.style.transform = 'translateY(-4px)'
    el.addEventListener('transitionend', () => el.remove(), { once: true })
    setTimeout(() => { if (el.parentNode) el.remove() }, 400)
  }

  private createPerch(session: Session, index: number, total: number): HTMLElement {
    const perch = document.createElement('div')
    perch.className = 'mcb-perch mcb-arriving'
    perch.dataset.sessionId = session.id
    ;(perch as unknown as { __session: Session }).__session = session
    perch.setAttribute('role', 'button')
    perch.setAttribute('tabindex', '0')
    const cityName = session.cityId ? this.cityNameById.get(session.cityId) : null
    const fullName = session.tmuxSession || session.name
    perch.setAttribute(
      'aria-label',
      cityName ? `Recent worker ${fullName} on ${cityName}` : `Recent worker ${fullName}`,
    )
    perch.classList.toggle('is-working', session.status === 'working')

    const opacity = 0.32 + ((total - 1 - index) / Math.max(total - 1, 1)) * 0.45
    perch.style.opacity = String(opacity)
    const angle = this.nameToAngle(session.name)
    perch.style.animationDelay = `${index * 60}ms`
    this.attachWorkerHover(perch)

    const bird = document.createElement('img')
    bird.className = 'mcb-bird'
    bird.src = '/cursors/bird-small.png'
    bird.alt = ''
    bird.draggable = false
    bird.style.transform = `rotate(${angle}deg)`

    const label = document.createElement('span')
    label.className = 'mcb-worker-name'
    label.textContent = this.workerDisplayName(session)

    perch.append(bird, label)
    return perch
  }

  private workerDisplayName(session: Session): string {
    return session.name || session.tmuxSession || 'worker'
  }

  private attachWorkerHover(perch: HTMLElement): void {
    const show = (): void => {
      const session = (perch as unknown as { __session?: Session }).__session
      if (session) this.opts.onWorkerHoverStart?.(session, this.workerTooltipAnchor(perch))
    }
    const hide = (): void => {
      this.opts.onWorkerHoverEnd?.()
    }
    perch.addEventListener('mouseenter', show)
    perch.addEventListener('focus', show)
    perch.addEventListener('mouseleave', hide)
    perch.addEventListener('blur', hide)
  }

  private workerTooltipAnchor(perch: HTMLElement): { x: number; y: number } {
    const rect = perch.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.bottom + 4,
    }
  }

  private nameToAngle(name: string): number {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
    }
    return (hash % 21) - 10
  }

  // ───────────── awaiting-review badge poll ─────────────

  private startPolling(): void {
    this.pollTimer = window.setInterval(() => {
      if (this.opts.isKanbanModalOpen?.()) return
      void this.refreshAwaitingReview()
    }, this.pollIntervalMs)
  }

  private async refreshAwaitingReview(): Promise<void> {
    try {
      const cityId = this.opts.getKanbanBadgeCityId?.() ?? null
      const url = cityId
        ? `${this.apiBase}/kanban?cityId=${encodeURIComponent(cityId)}`
        : `${this.apiBase}/kanban`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json() as { totals?: { awaitingReview?: number } }
      const n = data.totals?.awaitingReview ?? 0
      if (n === this.lastBadgeValue) return
      this.lastBadgeValue = n
      if (n > 0) {
        this.kanbanBadge.textContent = n > 99 ? '99+' : String(n)
        this.kanbanBadge.style.display = ''
        this.chipKanban.setAttribute('aria-label', `Open kanban (k) — ${n} awaiting review`)
      } else {
        this.kanbanBadge.style.display = 'none'
        this.chipKanban.setAttribute('aria-label', 'Open kanban (k)')
      }
    } catch {
      // Silent — the badge is a hint, not a contract.
    }
  }

  // ───────────── styles ─────────────

  private injectStyles(): void {
    if (document.getElementById('mcb-styles')) return
    const style = document.createElement('style')
    style.id = 'mcb-styles'
    style.textContent = `
      .mcb-bar {
        position: fixed;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 50;
        display: flex;
        align-items: stretch;
        gap: 12px;
        min-height: 54px;
        max-width: calc(100vw - 24px);
        box-sizing: border-box;
        padding: 6px 12px;
        background: rgba(237, 232, 224, 0.78);
        backdrop-filter: blur(2px);
        border: 1px solid rgba(122, 112, 104, 0.18);
        border-radius: 4px;
        box-shadow: 0 1px 3px rgba(46, 42, 38, 0.06);
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 11px;
        color: var(--ink-faded, #7A7068);
        letter-spacing: 0.03em;
      }

      /* ── launch button (▣ vellum) ── */
      .mcb-launch {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 34px;
        align-self: center;
        padding: 0 10px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 3px;
        color: var(--ink-faded, #7A7068);
        cursor: pointer;
        transition: color 150ms ease, border-color 150ms ease, background 150ms ease;
        font: inherit;
      }
      .mcb-launch:hover {
        color: var(--ink-dark, #2A2520);
        border-color: rgba(46, 42, 38, 0.18);
        background: rgba(255, 255, 255, 0.55);
      }
      .mcb-launch:focus { outline: none; }
      .mcb-launch:focus-visible {
        outline: 1px dashed var(--ink-faded, #7A7068);
        outline-offset: 2px;
      }
      .mcb-launch-icon { display: inline-flex; align-items: center; justify-content: center; }
      .mcb-launch-label {
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 13px;
        font-style: italic;
        letter-spacing: 0.02em;
      }

      /* ── V / K / F chips ── */
      .mcb-chips {
        display: inline-flex;
        align-self: center;
        gap: 4px;
      }
      .mcb-chip {
        position: relative;
        width: 26px;
        height: 26px;
        padding: 0;
        background: transparent;
        border: 1px solid rgba(122, 112, 104, 0.22);
        border-radius: 3px;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.05em;
        color: var(--ink-faded, #7A7068);
        cursor: pointer;
        transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
      }
      .mcb-chip:hover {
        color: var(--ink-dark, #2A2520);
        border-color: rgba(46, 42, 38, 0.36);
      }
      .mcb-chip.is-active {
        color: #FBF7F0;
        background: var(--ink-dark, #2A2520);
        border-color: var(--ink-dark, #2A2520);
      }
      .mcb-chip:focus { outline: none; }
      .mcb-chip:focus-visible {
        outline: 1px dashed var(--ink-faded, #7A7068);
        outline-offset: 2px;
      }
      .mcb-chip-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 14px;
        height: 14px;
        padding: 0 3px;
        background: #9A7B35;
        color: #FBF7F0;
        border-radius: 7px;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 9.5px;
        line-height: 14px;
        text-align: center;
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      /* ── separators ── */
      .mcb-sep {
        display: inline-block;
        align-self: center;
        width: 1px;
        height: 28px;
        background: rgba(122, 112, 104, 0.22);
      }

      /* ── focused city plaque ── */
      .mcb-city {
        display: inline-flex;
        align-items: center;
        align-content: center;
        flex: 0 0 auto;
        min-width: max-content;
        padding: 3px 10px 2px;
        color: var(--ink-dark, #2A2520);
      }
      .mcb-city-name {
        white-space: nowrap;
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 15.5px;
        line-height: 1.05;
        font-style: normal;
        font-variant: small-caps;
        font-variant-caps: small-caps;
        font-feature-settings: "smcp" 1;
        text-transform: none;
        letter-spacing: 0.045em;
      }
      .mcb-city-empty .mcb-city-name { color: var(--ink-faded, #7A7068); }

      /* ── worker birds ── */
      .mcb-birds {
        display: inline-flex;
        align-items: center;
        flex: 1 1 auto;
        overflow: hidden;
        gap: 8px;
        min-width: 0; /* let it shrink, doesn't push glance off */
      }
      .mcb-birds-empty { display: none; }
      .mcb-birds-empty + .mcb-sep { display: none; }

      @keyframes mcb-land {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: var(--mcb-target-opacity, 0.55); transform: translateY(0); }
      }

      .mcb-perch {
        position: relative;
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 5px;
        width: 68px;
        flex: 0 0 68px;
        min-height: 40px;
        cursor: pointer;
        transition: opacity 200ms ease, transform 200ms ease;
        color: var(--ink-faded, #7A7068);
      }
      .mcb-perch.mcb-arriving {
        animation: mcb-land 280ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
      }
      .mcb-perch:hover,
      .mcb-perch:focus-visible {
        opacity: 1 !important;
      }
      .mcb-perch:focus { outline: none; }
      .mcb-perch:focus-visible {
        outline: 1px dashed var(--ink-faded, #7A7068);
        outline-offset: 2px;
        border-radius: 2px;
      }
      .mcb-bird {
        width: 16px;
        height: 16px;
        transition: transform 200ms ease, filter 200ms ease;
        filter: sepia(1) saturate(2) hue-rotate(100deg) brightness(0.45);
      }
      .mcb-perch:hover .mcb-bird,
      .mcb-perch:focus-within .mcb-bird {
        transform: rotate(0deg) scale(1.18) !important;
        filter: sepia(1) saturate(2) hue-rotate(100deg) brightness(0.32);
      }
      .mcb-perch.is-working .mcb-bird {
        filter: sepia(1) saturate(1.7) hue-rotate(124deg) brightness(0.46);
      }
      .mcb-worker-name {
        width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 9.5px;
        line-height: 1.1;
        letter-spacing: 0;
        color: var(--ink-faded, #7A7068);
      }
      .mcb-perch:hover .mcb-worker-name,
      .mcb-perch:focus-within .mcb-worker-name {
        color: var(--ink-dark, #2A2520);
      }

      /* ── activity glance (right edge) ── */
      .mcb-glance {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
        font-family: var(--font-main, 'EB Garamond', serif);
        font-style: italic;
        font-size: 12px;
        color: var(--ink-faded, #7A7068);
      }
      .mcb-glance.mcb-empty { display: none; }
      .mcb-glance.mcb-empty + .mcb-sep { display: none; }

      @media (max-width: 820px) {
        .mcb-bar { gap: 8px; padding-inline: 8px; }
        .mcb-launch-label { display: none; }
        .mcb-city { padding-inline: 7px; }
        .mcb-perch { width: 54px; flex-basis: 54px; }
      }
    `
    document.head.appendChild(style)
  }
}
