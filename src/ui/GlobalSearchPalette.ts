import type { City, Session } from '../state/types'

type SearchResult =
  | { type: 'city'; city: City }
  | { type: 'worker'; session: Session; cityName: string }

interface GlobalSearchPaletteOptions {
  onSelectCity: (city: City) => void
  onSelectWorker: (session: Session) => void
}

/** A city with its associated workers, for tree rendering. */
interface CityGroup {
  city: City
  workers: Array<{ session: Session; cityName: string }>
}

// Inline SVG hex icon (flat-top hexagon, matches the map grid)
const HEX_SVG = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1L12.2 4V10L7 13L1.8 10V4L7 1Z" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>`

export class GlobalSearchPalette {
  private readonly onSelectCity: (city: City) => void
  private readonly onSelectWorker: (session: Session) => void

  private readonly backdrop: HTMLDivElement
  private readonly palette: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly results: HTMLDivElement

  private cities: City[] = []
  private sessions: Session[] = []
  private cityNameById = new Map<string, string>()
  private visible = false
  private filteredResults: SearchResult[] = []
  private selectedIndex = 0

  private readonly onBackdropClick: (event: MouseEvent) => void
  private readonly onDocumentKeydown: (event: KeyboardEvent) => void
  private readonly onInput: () => void
  private readonly onInputKeydown: (event: KeyboardEvent) => void
  private readonly onResultsMouseMove: (event: MouseEvent) => void
  private readonly onResultsClick: (event: MouseEvent) => void

  constructor(options: GlobalSearchPaletteOptions) {
    this.onSelectCity = options.onSelectCity
    this.onSelectWorker = options.onSelectWorker

    this.injectStyles()

    this.backdrop = document.createElement('div')
    this.backdrop.className = 'gs-backdrop'
    this.backdrop.style.display = 'none'

    this.palette = document.createElement('div')
    this.palette.className = 'gs-palette'
    this.palette.style.display = 'none'

    const inputWrap = document.createElement('div')
    inputWrap.className = 'gs-input-wrap'

    this.input = document.createElement('input')
    this.input.className = 'gs-input'
    this.input.type = 'text'
    this.input.placeholder = 'Navigate to\u2026'
    this.input.spellcheck = false

    const hint = document.createElement('kbd')
    hint.className = 'gs-hint'
    hint.textContent = 'esc'

    inputWrap.append(this.input, hint)

    this.results = document.createElement('div')
    this.results.className = 'gs-results'

    this.palette.append(inputWrap, this.results)
    document.body.append(this.backdrop, this.palette)

    this.onBackdropClick = (event) => {
      if (event.target === this.backdrop) this.hide()
    }
    this.onDocumentKeydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.hide() }
    }
    this.onInput = () => this.renderResults()
    this.onInputKeydown = (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); this.moveSelection(1); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); this.moveSelection(-1); return }
      if (event.key === 'Enter') { event.preventDefault(); this.activateSelection(this.selectedIndex); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.hide() }
    }
    this.onResultsMouseMove = (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('.gs-item')
      if (!item) return
      const index = Number(item.dataset.index)
      if (!Number.isFinite(index) || index === this.selectedIndex) return
      this.selectedIndex = index
      this.updateSelection()
    }
    this.onResultsClick = (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('.gs-item')
      if (!item) return
      const index = Number(item.dataset.index)
      if (Number.isFinite(index)) this.activateSelection(index)
    }
  }

  show(cities: City[], sessions: Session[]): void {
    if (this.visible) this.hide()
    this.cities = cities.slice().sort((a, b) => a.name.localeCompare(b.name))
    this.sessions = sessions.slice().sort((a, b) => a.name.localeCompare(b.name))
    this.cityNameById = new Map(this.cities.map(city => [city.id, city.name]))
    this.visible = true
    this.selectedIndex = 0
    this.input.value = ''
    this.backdrop.style.display = 'block'
    this.palette.style.display = 'flex'
    this.attachListeners()
    this.renderResults()
    requestAnimationFrame(() => {
      this.palette.classList.add('gs-entering')
      this.input.focus()
    })
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.detachListeners()
    this.palette.classList.remove('gs-entering')
    this.backdrop.style.display = 'none'
    this.palette.style.display = 'none'
    this.input.value = ''
    this.results.innerHTML = ''
    this.filteredResults = []
  }

  isVisible(): boolean {
    return this.visible
  }

  private attachListeners(): void {
    this.backdrop.addEventListener('click', this.onBackdropClick)
    document.addEventListener('keydown', this.onDocumentKeydown)
    this.input.addEventListener('input', this.onInput)
    this.input.addEventListener('keydown', this.onInputKeydown)
    this.results.addEventListener('mousemove', this.onResultsMouseMove)
    this.results.addEventListener('click', this.onResultsClick)
  }

  private detachListeners(): void {
    this.backdrop.removeEventListener('click', this.onBackdropClick)
    document.removeEventListener('keydown', this.onDocumentKeydown)
    this.input.removeEventListener('input', this.onInput)
    this.input.removeEventListener('keydown', this.onInputKeydown)
    this.results.removeEventListener('mousemove', this.onResultsMouseMove)
    this.results.removeEventListener('click', this.onResultsClick)
  }

  /**
   * Find the best initial selection index for a query.
   * If the query directly matches a worker name, select that worker
   * (not the parent city that was pulled in as context).
   */
  private findBestMatch(query: string): number {
    if (!query) return 0

    // Exact worker name match first
    const exactWorker = this.filteredResults.findIndex(r =>
      r.type === 'worker' && r.session.name.toLowerCase() === query
    )
    if (exactWorker >= 0) return exactWorker

    // Worker name starts with query
    const startsWorker = this.filteredResults.findIndex(r =>
      r.type === 'worker' && r.session.name.toLowerCase().startsWith(query)
    )
    if (startsWorker >= 0) return startsWorker

    // Worker name contains query
    const containsWorker = this.filteredResults.findIndex(r =>
      r.type === 'worker' && r.session.name.toLowerCase().includes(query)
    )
    if (containsWorker >= 0) return containsWorker

    // City name match (fallback — city was the direct match)
    return 0
  }

  private renderResults(): void {
    const query = this.input.value.trim().toLowerCase()

    // Build tree: group workers under their city
    const groups: CityGroup[] = this.cities
      .filter(city => !query || city.name.toLowerCase().includes(query))
      .map(city => ({
        city,
        workers: this.sessions
          .filter(s => s.cityId === city.id)
          .map(session => ({ session, cityName: city.name })),
      }))

    // Workers matching query but whose city didn't match — pull in their city as context
    const matchedCityIds = new Set(groups.map(g => g.city.id))
    if (query) {
      const extraWorkers = this.sessions.filter(s =>
        !matchedCityIds.has(s.cityId || '') &&
        (s.name.toLowerCase().includes(query) ||
         (s.cityId && (this.cityNameById.get(s.cityId) || '').toLowerCase().includes(query)))
      )
      for (const session of extraWorkers) {
        const city = this.cities.find(c => c.id === session.cityId)
        if (city) {
          let group = groups.find(g => g.city.id === city.id)
          if (!group) {
            group = { city, workers: [] }
            groups.push(group)
          }
          if (!group.workers.some(w => w.session.id === session.id)) {
            group.workers.push({ session, cityName: city.name })
          }
        }
      }

      // For cities pulled in by worker match, show only matching workers
      for (const group of groups) {
        if (!matchedCityIds.has(group.city.id)) {
          group.workers = group.workers.filter(w =>
            w.session.name.toLowerCase().includes(query) ||
            w.cityName.toLowerCase().includes(query)
          )
        }
      }
    }

    // Orphan workers (no city)
    const orphanWorkers = this.sessions
      .filter(s => !s.cityId)
      .filter(s => !query || s.name.toLowerCase().includes(query))
      .map(session => ({ session, cityName: '' }))

    // Flatten into results list for keyboard nav
    this.filteredResults = []
    for (const group of groups) {
      this.filteredResults.push({ type: 'city', city: group.city })
      for (const w of group.workers) {
        this.filteredResults.push({ type: 'worker', session: w.session, cityName: w.cityName })
      }
    }
    for (const w of orphanWorkers) {
      this.filteredResults.push({ type: 'worker', session: w.session, cityName: w.cityName })
    }

    if (this.filteredResults.length === 0) {
      this.selectedIndex = 0
      this.results.innerHTML = '<div class="gs-empty">No matches</div>'
      return
    }

    // Smart selection: target the best match, not always index 0
    this.selectedIndex = this.findBestMatch(query)
    this.results.innerHTML = ''

    let itemOrdinal = 0

    for (const group of groups) {
      const cityIdx = this.filteredResults.findIndex(r => r.type === 'city' && r.city.id === group.city.id)
      this.results.appendChild(this.createCityItem(group.city, cityIdx, itemOrdinal++))

      for (const w of group.workers) {
        const wIdx = this.filteredResults.findIndex(r =>
          r.type === 'worker' && r.session.id === w.session.id
        )
        const isLast = w === group.workers[group.workers.length - 1]
        this.results.appendChild(this.createWorkerItem(w.session, wIdx, itemOrdinal++, isLast))
      }
    }

    for (const w of orphanWorkers) {
      const wIdx = this.filteredResults.findIndex(r =>
        r.type === 'worker' && r.session.id === w.session.id
      )
      this.results.appendChild(this.createWorkerItem(w.session, wIdx, itemOrdinal++, true))
    }

    this.updateSelection()
  }

  private createCityItem(city: City, index: number, ordinal: number): HTMLElement {
    const item = document.createElement('div')
    item.className = 'gs-item gs-city'
    item.dataset.index = String(index)
    item.style.animationDelay = `${ordinal * 30}ms`

    const icon = document.createElement('span')
    icon.className = 'gs-icon gs-icon-city'
    icon.innerHTML = HEX_SVG

    const label = document.createElement('span')
    label.className = 'gs-label'
    label.textContent = city.name

    item.append(icon, label)
    return item
  }

  private createWorkerItem(session: Session, index: number, ordinal: number, isLast: boolean): HTMLElement {
    const item = document.createElement('div')
    item.className = 'gs-item gs-worker'
    item.dataset.index = String(index)
    item.style.animationDelay = `${ordinal * 30}ms`

    const branch = document.createElement('span')
    branch.className = `gs-branch ${isLast ? 'gs-branch-last' : ''}`

    const bird = document.createElement('img')
    bird.className = 'gs-icon-bird'
    bird.src = '/cursors/bird-small.png'
    bird.alt = ''

    const label = document.createElement('span')
    label.className = 'gs-label'
    label.textContent = session.name

    item.append(branch, bird, label)
    return item
  }

  private moveSelection(delta: number): void {
    if (this.filteredResults.length === 0) return
    this.selectedIndex = (this.selectedIndex + delta + this.filteredResults.length) % this.filteredResults.length
    this.updateSelection()
  }

  private updateSelection(): void {
    const items = this.results.querySelectorAll<HTMLElement>('.gs-item')
    items.forEach((item) => {
      item.classList.toggle('selected', Number(item.dataset.index) === this.selectedIndex)
    })
    const selected = this.results.querySelector<HTMLElement>(`.gs-item[data-index="${this.selectedIndex}"]`)
    selected?.scrollIntoView({ block: 'nearest' })
  }

  private activateSelection(index: number): void {
    const result = this.filteredResults[index]
    if (!result) return
    this.hide()
    if (result.type === 'city') {
      this.onSelectCity(result.city)
      return
    }
    this.onSelectWorker(result.session)
  }

  private injectStyles(): void {
    if (document.getElementById('gs-palette-styles')) return

    const style = document.createElement('style')
    style.id = 'gs-palette-styles'
    style.textContent = `
      /* ── Backdrop ── */
      .gs-backdrop {
        position: fixed; inset: 0;
        background: rgba(42, 37, 32, 0.25);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        z-index: 1000;
      }

      /* ── Palette shell ── */
      @keyframes gs-drop {
        from { opacity: 0; transform: translateX(-50%) translateY(-12px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
      }

      .gs-palette {
        position: fixed;
        top: 14%; left: 50%;
        transform: translateX(-50%);
        width: 380px;
        max-height: 440px;
        background: var(--parchment-light, #E5D9C8);
        border: 1px solid var(--parchment-edge, #BBA890);
        border-top: 2px solid var(--verdigris, #4A6258);
        border-radius: 4px;
        box-shadow:
          0 1px 0 rgba(255,255,255,0.35) inset,
          0 12px 40px rgba(42, 37, 32, 0.28),
          0 2px 8px rgba(42, 37, 32, 0.12);
        font-family: var(--font-main, 'EB Garamond', serif);
        color: var(--ink-body, #3D3630);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 1001;
        opacity: 0;
      }

      .gs-palette.gs-entering {
        animation: gs-drop 200ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }

      /* ── Input area ── */
      .gs-input-wrap {
        display: flex;
        align-items: center;
        padding: 0 14px;
        border-bottom: 1px solid var(--parchment-edge, #BBA890);
        gap: 8px;
      }

      .gs-input {
        flex: 1;
        padding: 13px 0;
        border: none;
        background: transparent;
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 17px;
        color: var(--ink-dark, #2A2520);
        outline: none;
        letter-spacing: 0.01em;
      }

      .gs-input::placeholder {
        color: var(--ink-faded, #7A7068);
        font-style: italic;
      }

      .gs-hint {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10px;
        color: var(--ink-faded, #7A7068);
        background: var(--parchment-dark, #C9BAA5);
        border: 1px solid var(--parchment-edge, #BBA890);
        border-radius: 3px;
        padding: 1px 5px;
        line-height: 1.4;
        flex-shrink: 0;
      }

      /* ── Results tree ── */
      .gs-results {
        overflow-y: auto;
        max-height: 360px;
        padding: 6px 0;
      }

      .gs-results::-webkit-scrollbar { width: 6px; }
      .gs-results::-webkit-scrollbar-track { background: transparent; }
      .gs-results::-webkit-scrollbar-thumb {
        background: var(--parchment-edge, #BBA890);
        border-radius: 3px;
      }

      /* ── Staggered entrance ── */
      @keyframes gs-fade-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .gs-item {
        display: flex;
        align-items: center;
        cursor: pointer;
        position: relative;
        transition: background 100ms ease;
        animation: gs-fade-in 180ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
      }

      /* ── Icons ── */
      .gs-icon {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .gs-icon-city {
        width: 14px; height: 14px;
        color: var(--verdigris, #4A6258);
        opacity: 0.7;
        transition: opacity 100ms ease, color 100ms ease;
      }

      .gs-icon-city svg { display: block; }

      .gs-icon-bird {
        width: 13px; height: 13px;
        flex-shrink: 0;
        opacity: 0.45;
        transition: opacity 100ms ease;
        /* bird sprite is black; tint it with the rust color */
        filter: sepia(1) saturate(3) hue-rotate(-15deg) brightness(0.55);
      }

      /* ── City row ── */
      .gs-city {
        padding: 7px 14px;
        gap: 9px;
        margin-top: 2px;
      }

      .gs-city .gs-label {
        font-size: 15.5px;
        font-weight: 500;
        letter-spacing: 0.02em;
        color: var(--ink-dark, #2A2520);
      }

      /* ── Worker row (tree branch) ── */
      .gs-worker {
        padding: 5px 14px 5px 18px;
        gap: 6px;
      }

      .gs-branch {
        width: 22px;
        height: 100%;
        position: relative;
        flex-shrink: 0;
      }

      /* vertical trunk */
      .gs-branch::before {
        content: '';
        position: absolute;
        left: 3px;
        top: -5px;
        bottom: -5px;
        width: 1px;
        background: var(--verdigris, #4A6258);
        opacity: 0.25;
      }

      /* horizontal twig */
      .gs-branch::after {
        content: '';
        position: absolute;
        left: 3px;
        top: 50%;
        width: 12px;
        height: 1px;
        background: var(--verdigris, #4A6258);
        opacity: 0.25;
      }

      .gs-branch-last::before {
        bottom: 50%;
      }

      .gs-worker .gs-label {
        color: var(--ink-light, #5A524A);
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 12.5px;
        letter-spacing: 0.03em;
      }

      /* ── Selection states ── */

      /* City selected: verdigris accent */
      .gs-city.selected {
        background: rgba(74, 98, 88, 0.1);
      }

      .gs-city.selected::after {
        content: '';
        position: absolute;
        left: 0; top: 2px; bottom: 2px;
        width: 2.5px;
        background: var(--verdigris, #4A6258);
        border-radius: 0 2px 2px 0;
      }

      .gs-city.selected .gs-icon-city {
        opacity: 1;
        color: var(--verdigris, #4A6258);
      }

      /* Worker selected: rust accent */
      .gs-worker.selected {
        background: rgba(138, 85, 72, 0.1);
      }

      .gs-worker.selected::after {
        content: '';
        position: absolute;
        left: 0; top: 2px; bottom: 2px;
        width: 2.5px;
        background: var(--rust, #8A5548);
        border-radius: 0 2px 2px 0;
      }

      .gs-worker.selected .gs-icon-bird {
        opacity: 0.8;
      }

      .gs-worker.selected .gs-label {
        color: var(--ink-dark, #2A2520);
      }

      .gs-item:hover:not(.selected) {
        background: rgba(74, 98, 88, 0.05);
      }

      /* ── Empty state ── */
      .gs-empty {
        padding: 20px 14px;
        color: var(--ink-faded, #7A7068);
        font-style: italic;
        text-align: center;
        font-size: 14px;
      }
    `
    document.head.appendChild(style)
  }
}
