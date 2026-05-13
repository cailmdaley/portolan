import type { City, Session } from '../state/types'
import { lockModalBackground } from './modalBackgroundLock'

/**
 * One fiber match returned by the `/global-search` endpoint. The shape
 * mirrors HttpApiGlobalSearch.GlobalSearchHit on the server — kept in this
 * module rather than imported from `../../server/...` to preserve the
 * frontend / backend boundary the rest of `src/ui/` follows.
 */
export interface FiberSearchHit {
  /** Click-through slug — project-relative when `cityId` is set, else loomId. */
  id: string
  loomId?: string
  name: string
  status: string
  kind: string
  tags: string[]
  outcome?: string
  snippet?: string
  originId: string
  cityId?: string
  projectSlug?: string
  hostname?: string
  score: number
}

type SearchResult =
  | { type: 'city'; city: City }
  | { type: 'worker'; session: Session; cityName: string }
  | { type: 'fiber'; hit: FiberSearchHit }

interface GlobalSearchPaletteOptions {
  onSelectCity: (city: City) => void
  onSelectWorker: (session: Session) => void
  /**
   * Open a fiber that was matched in the cross-project search section.
   * Receives the full hit so callers can pivot vellum to (cityId, projectSlug)
   * — the click-through identifier — while preserving origin/host context for
   * eventual remote-origin navigation. See [[ai-futures/portolan/design/
   * constitution-portolan-navigation-layer]] §"Stage 2".
   */
  onSelectFiber?: (hit: FiberSearchHit) => void
  /**
   * Async fiber search backend. The palette debounces input changes and
   * calls this with the trimmed lowercased query; the same query is also
   * used for in-memory city/worker filtering. Optional — when undefined
   * the Fibers section is hidden, preserving the original cities-and-workers
   * palette behaviour for callers that don't want fiber search.
   */
  searchFibers?: (query: string) => Promise<FiberSearchHit[]>
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
  private readonly onSelectFiber: ((hit: FiberSearchHit) => void) | null
  private readonly searchFibers: ((query: string) => Promise<FiberSearchHit[]>) | null

  private readonly backdrop: HTMLDivElement
  private readonly palette: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly results: HTMLDivElement

  private cities: City[] = []
  private sessions: Session[] = []
  private cityNameById = new Map<string, string>()
  private ambiguousCityNames = new Set<string>()
  private visible = false
  private filteredResults: SearchResult[] = []
  private selectedIndex = 0
  // Fiber-search async state. Re-rendering happens twice per keystroke when
  // fibers are wired: once synchronously for the cities/workers, then again
  // when the fiber Promise resolves. Stored alongside the input value (the
  // debounce token) so a stale resolution from a fast typer doesn't blow
  // away a fresher render.
  private fiberHits: FiberSearchHit[] = []
  private fiberQuery: string = ''
  private fiberLoading = false
  private fiberDebounceTimer: ReturnType<typeof setTimeout> | null = null
  // Tracks the last query that triggered a "smart selection" via findBestMatch.
  // Re-rendering for an async fiber resolution shouldn't blow away the
  // user's ArrowDown/ArrowUp navigation, so we only re-pick when the
  // input itself has changed.
  private lastSelectionQuery: string | null = null
  // Debounce: ~110ms felt right empirically for cross-origin felt walks.
  // Short enough that fast typers don't see lag between cities/workers
  // (synchronous) and fibers (async); long enough to coalesce a typed
  // word into one /global-search request, not one per keypress.
  private static readonly FIBER_DEBOUNCE_MS = 110
  // Set in show(), called and cleared in hide(). See modalBackgroundLock —
  // the palette is role=dialog aria-modal=true, so background siblings (map,
  // city HUD, pinned cards, recent-worker bar) must be inerted while it's open.
  private unlockBackground: (() => void) | null = null

  private readonly onBackdropClick: (event: MouseEvent) => void
  private readonly onDocumentKeydown: (event: KeyboardEvent) => void
  private readonly onInput: () => void
  private readonly onInputKeydown: (event: KeyboardEvent) => void
  private readonly onResultsMouseMove: (event: MouseEvent) => void
  private readonly onResultsClick: (event: MouseEvent) => void

  constructor(options: GlobalSearchPaletteOptions) {
    this.onSelectCity = options.onSelectCity
    this.onSelectWorker = options.onSelectWorker
    this.onSelectFiber = options.onSelectFiber ?? null
    this.searchFibers = options.searchFibers ?? null

    this.injectStyles()

    this.backdrop = document.createElement('div')
    this.backdrop.className = 'gs-backdrop'
    this.backdrop.style.display = 'none'

    this.palette = document.createElement('div')
    this.palette.className = 'gs-palette'
    this.palette.style.display = 'none'
    this.palette.setAttribute('role', 'dialog')
    this.palette.setAttribute('aria-label', 'Navigate to city or worker')
    this.palette.setAttribute('aria-modal', 'true')

    const inputWrap = document.createElement('div')
    inputWrap.className = 'gs-input-wrap'

    this.input = document.createElement('input')
    this.input.className = 'gs-input'
    this.input.type = 'text'
    this.input.placeholder = 'Navigate to\u2026'
    this.input.spellcheck = false
    this.input.setAttribute('aria-label', 'Search cities and workers')
    this.input.setAttribute('role', 'combobox')
    this.input.setAttribute('aria-autocomplete', 'list')
    this.input.setAttribute('aria-controls', 'gs-results')

    const hint = document.createElement('kbd')
    hint.className = 'gs-hint'
    hint.textContent = 'esc'

    inputWrap.append(this.input, hint)

    this.results = document.createElement('div')
    this.results.className = 'gs-results'
    this.results.id = 'gs-results'
    this.results.setAttribute('role', 'listbox')
    this.results.setAttribute('aria-label', 'Search results')

    this.palette.append(inputWrap, this.results)
    document.body.append(this.backdrop, this.palette)

    this.onBackdropClick = (event) => {
      if (event.target === this.backdrop) this.hide()
    }
    this.onDocumentKeydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.hide() }
    }
    this.onInput = () => {
      this.renderResults()
      this.scheduleFiberSearch()
    }
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
    // Stale fibers from a previous show() would render until the first
    // input event fires; clear here so an empty palette starts empty.
    this.fiberHits = []
    this.fiberQuery = ''
    this.fiberLoading = false
    // Names shared by 2+ cities get an origin suffix on map labels
    // (2d9c75d); mirror that in the palette so "City ai-futures" isn't
    // rendered twice with identical names when a remote project shares a
    // slug with a local one.
    const nameCounts = new Map<string, number>()
    for (const c of this.cities) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1)
    this.ambiguousCityNames = new Set(
      Array.from(nameCounts).filter(([, n]) => n > 1).map(([name]) => name),
    )
    this.cityNameById = new Map(this.cities.map(city => [city.id, city.name]))
    this.visible = true
    this.selectedIndex = 0
    this.input.value = ''
    this.backdrop.style.display = 'block'
    this.palette.style.display = 'flex'
    // Inert background siblings before showing — gs-palette and gs-backdrop
    // are skipped by lockModalBackground, so this also works correctly when
    // the palette opens over another modal (Cmd-K-style nav over an open
    // vellum reader, etc.).
    this.unlockBackground?.()
    this.unlockBackground = lockModalBackground(this.palette)
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
    if (this.fiberDebounceTimer !== null) {
      clearTimeout(this.fiberDebounceTimer)
      this.fiberDebounceTimer = null
    }
    this.fiberHits = []
    this.fiberQuery = ''
    this.fiberLoading = false
    this.lastSelectionQuery = null
    this.unlockBackground?.()
    this.unlockBackground = null
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

    // Match against the full tmux session name — `session.name` is the
    // elided display form (truncated at 10 chars + "…"), so a search for
    // "vellum-dogfood" would miss a session named "ralph-vellum-dogfood"
    // whose display is "ralph-vell…".
    const matchName = (r: SearchResult): string =>
      (r.type === 'worker' ? (r.session.tmuxSession || r.session.name) : '').toLowerCase()

    // Exact worker name match first
    const exactWorker = this.filteredResults.findIndex(r =>
      r.type === 'worker' && matchName(r) === query
    )
    if (exactWorker >= 0) return exactWorker

    // Worker name starts with query
    const startsWorker = this.filteredResults.findIndex(r =>
      r.type === 'worker' && matchName(r).startsWith(query)
    )
    if (startsWorker >= 0) return startsWorker

    // Worker name contains query
    const containsWorker = this.filteredResults.findIndex(r =>
      r.type === 'worker' && matchName(r).includes(query)
    )
    if (containsWorker >= 0) return containsWorker

    // City name match (fallback — city was the direct match)
    return 0
  }

  private renderResults(): void {
    const query = this.input.value.trim().toLowerCase()

    // City matches against name + origin label, so a remote city named
    // "ai-futures on candide" filters when the user types "candide".
    // Mirrors the disambiguated aria-label/visual-label rendering further
    // down: the searchable text matches what the user sees.
    const cityHaystack = (city: City): string => {
      const origin = city.originId === 'local' ? '' : ` ${city.originId.replace(/^remote-/, '')}`
      return (city.name + origin).toLowerCase()
    }

    // Build tree: group workers under their city
    const groups: CityGroup[] = this.cities
      .filter(city => !query || cityHaystack(city).includes(query))
      .map(city => ({
        city,
        workers: this.sessions
          .filter(s => s.cityId === city.id)
          .map(session => ({ session, cityName: city.name })),
      }))

    // Workers matching query but whose city didn't match — pull in their city as context
    const matchedCityIds = new Set(groups.map(g => g.city.id))
    // Match search against full tmuxSession name, not the truncated display form.
    const sessionMatches = (s: Session): boolean => (s.tmuxSession || s.name).toLowerCase().includes(query)
    // City lookup by id matches the same haystack as the top-level filter so
    // worker-side matches that pull their parent city in by name + origin
    // stay consistent with the city-level filter above.
    const cityById = new Map(this.cities.map(c => [c.id, c]))
    const cityIdMatches = (cityId: string | null | undefined): boolean => {
      if (!cityId) return false
      const c = cityById.get(cityId)
      return c ? cityHaystack(c).includes(query) : false
    }
    if (query) {
      const extraWorkers = this.sessions.filter(s =>
        !matchedCityIds.has(s.cityId || '') &&
        (sessionMatches(s) || cityIdMatches(s.cityId))
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
            sessionMatches(w.session) ||
            cityHaystack(group.city).includes(query)
          )
        }
      }
    }

    // Orphan workers (no city)
    const orphanWorkers = this.sessions
      .filter(s => !s.cityId)
      .filter(s => !query || sessionMatches(s))
      .map(session => ({ session, cityName: '' }))

    // Fiber hits — only counted into the flat result list (and rendered)
    // when the latest async resolution matches the current input. A stale
    // resolution from a fast typer (input "shut" then "shuttle") would
    // otherwise leak into the displayed list. Hidden entirely when no
    // searchFibers callback was provided.
    const fiberHits = this.searchFibers && query && this.fiberQuery === query
      ? this.fiberHits
      : []

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
    for (const hit of fiberHits) {
      this.filteredResults.push({ type: 'fiber', hit })
    }

    if (this.filteredResults.length === 0 && !this.fiberLoading) {
      this.selectedIndex = 0
      // The container carries role="listbox" — a generic <div> child with no
      // role is invisible to a11y inside a listbox (which expects options),
      // so an empty-state message rendered as a bare div leaves screen
      // readers and the agent-browser snapshot announcing the listbox as
      // empty. Render the empty state as an aria-disabled option carrying
      // the "No matches" text. Mirrors vellum's `vellum-search-no-results`
      // fix (vellum 7a7d78b) and `hud-search-no-results` precedent.
      this.results.innerHTML = '<div class="gs-empty" role="option" aria-disabled="true">No matches</div>'
      return
    }

    // Smart selection: target the best match, not always index 0. Only
    // re-pick when the input changed since the last render — async fiber
    // resolutions trigger renderResults too, and clobbering selectedIndex
    // there would yank the user out of any ArrowDown navigation they did
    // while waiting for the fiber Promise to land.
    if (this.lastSelectionQuery !== query) {
      this.selectedIndex = this.findBestMatch(query)
      this.lastSelectionQuery = query
    } else if (this.selectedIndex >= this.filteredResults.length) {
      // The result set may have shrunk (or, more likely, grown — fibers
      // appended below cities/workers). If the prior index is now out of
      // range, fall back to the front of the list rather than rendering
      // nothing-selected.
      this.selectedIndex = 0
    }
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

    if (fiberHits.length > 0) {
      this.results.appendChild(this.createSectionHeader('Fibers', itemOrdinal++))
      for (const hit of fiberHits) {
        const idx = this.filteredResults.findIndex(
          r => r.type === 'fiber' && r.hit.id === hit.id && r.hit.originId === hit.originId,
        )
        this.results.appendChild(this.createFiberItem(hit, idx, itemOrdinal++))
      }
    } else if (this.fiberLoading && this.searchFibers && query) {
      // Async search in flight — show a tiny placeholder so the user knows
      // a fiber section is coming, not that there are zero matches. No
      // role on the placeholder so keyboard nav skips it.
      this.results.appendChild(this.createFiberLoadingPlaceholder(itemOrdinal++))
    }

    this.updateSelection()
  }

  private createCityItem(city: City, index: number, ordinal: number): HTMLElement {
    const item = document.createElement('div')
    item.className = 'gs-item gs-city'
    item.dataset.index = String(index)
    item.style.animationDelay = `${ordinal * 30}ms`
    item.setAttribute('role', 'option')

    // When two cities share a name (local + remote), disambiguate by origin
    // host — same pattern as the map label in 2d9c75d. Local is elided as
    // the default. Without this, the palette shows "City ai-futures"
    // twice identically and there's no way to tell which one you're
    // selecting.
    const ambiguous = this.ambiguousCityNames.has(city.name) && city.originId !== 'local'
    const hostLabel = ambiguous ? city.originId.replace(/^remote-/, '') : ''
    item.setAttribute('aria-label', ambiguous ? `City ${city.name} on ${hostLabel}` : `City ${city.name}`)

    const icon = document.createElement('span')
    icon.className = 'gs-icon gs-icon-city'
    icon.innerHTML = HEX_SVG

    const label = document.createElement('span')
    label.className = 'gs-label'
    label.textContent = city.name
    if (ambiguous) {
      const origin = document.createElement('span')
      origin.className = 'gs-city-origin'
      origin.textContent = hostLabel
      label.appendChild(origin)
    }

    item.append(icon, label)
    return item
  }

  private createSectionHeader(label: string, ordinal: number): HTMLElement {
    const header = document.createElement('div')
    header.className = 'gs-section-header'
    header.textContent = label
    header.style.animationDelay = `${ordinal * 30}ms`
    // Headers aren't selectable — keep them out of the listbox a11y tree.
    return header
  }

  private createFiberLoadingPlaceholder(ordinal: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'gs-fiber-loading'
    el.style.animationDelay = `${ordinal * 30}ms`
    el.setAttribute('aria-hidden', 'true')
    el.textContent = 'searching fibers…'
    return el
  }

  private createFiberItem(hit: FiberSearchHit, index: number, ordinal: number): HTMLElement {
    const item = document.createElement('div')
    item.className = 'gs-item gs-fiber'
    item.dataset.index = String(index)
    item.style.animationDelay = `${ordinal * 30}ms`
    item.setAttribute('role', 'option')
    // a11y label: "Fiber <name> in <project> on <host>" — give screen readers
    // enough context to disambiguate cross-project matches without forcing
    // the visual row to carry every breadcrumb.
    const projectLabel = this.projectLabelForFiberHit(hit)
    const hostLabel = hit.hostname ? ` on ${hit.hostname}` : ''
    item.setAttribute(
      'aria-label',
      `Fiber ${hit.name}${projectLabel ? ` in ${projectLabel}` : ''}${hostLabel}`,
    )

    // Glyph: a small ◆ stand-in for the fiber/diamond motif felt fibers carry
    // in vellum's rendering. Keeps the row visually distinct from cities (hex)
    // and workers (bird) without demanding a new sprite.
    const icon = document.createElement('span')
    icon.className = 'gs-icon gs-icon-fiber'
    icon.textContent = '◆'

    const main = document.createElement('span')
    main.className = 'gs-fiber-main'

    const title = document.createElement('span')
    title.className = 'gs-fiber-title'
    title.textContent = hit.name

    const meta = document.createElement('span')
    meta.className = 'gs-fiber-meta'
    const metaParts: string[] = []
    if (projectLabel) metaParts.push(projectLabel)
    if (hit.hostname) metaParts.push(hit.hostname)
    if (hit.status && hit.status !== 'open') metaParts.push(hit.status)
    meta.textContent = metaParts.join(' · ')

    main.append(title, meta)

    if (hit.snippet) {
      const snippet = document.createElement('span')
      snippet.className = 'gs-fiber-snippet'
      snippet.textContent = hit.snippet
      main.appendChild(snippet)
    }

    item.append(icon, main)
    return item
  }

  /**
   * Display label for a fiber hit's project — derived from cityId mapping
   * back to the loaded city list (so a fiber under "wedding" reads as "wedding"
   * in the meta line). Falls back to the hostname-stripped originId for remote
   * hits without a resolved city, and to empty for fibers we can't trace.
   */
  private projectLabelForFiberHit(hit: FiberSearchHit): string {
    if (hit.cityId) {
      const city = this.cities.find(c => c.id === hit.cityId)
      if (city) return city.name
    }
    return ''
  }

  private createWorkerItem(session: Session, index: number, ordinal: number, isLast: boolean): HTMLElement {
    const item = document.createElement('div')
    item.className = 'gs-item gs-worker'
    item.dataset.index = String(index)
    item.style.animationDelay = `${ordinal * 30}ms`
    // Full tmux session name on the a11y label, not the elided display form
    // (`session.name` is truncated to 10 chars + "…"); screen readers and
    // agent-browser snapshots need the real identity. Mirrors ce9910f's
    // treatment of worker chips.
    const fullName = session.tmuxSession || session.name
    // The visual tree-branch glyph groups workers under their city, but the
    // a11y tree is a flat listbox of options — without the city in the
    // label, screen-reader users hear "Worker claude" with no way to tell
    // which project's `claude` they're selecting. Mirrors the recent-worker
    // bar's "Recent worker X on Y" form.
    const cityName = session.cityId ? this.cityNameById.get(session.cityId) : undefined
    const a11yLabel = cityName ? `Worker ${fullName} on ${cityName}` : `Worker ${fullName}`
    item.setAttribute('role', 'option')
    item.setAttribute('aria-label', a11yLabel)

    const branch = document.createElement('span')
    branch.className = `gs-branch ${isLast ? 'gs-branch-last' : ''}`

    const bird = document.createElement('img')
    bird.className = 'gs-icon-bird'
    bird.src = '/cursors/bird-small.png'
    bird.alt = ''

    // Palette has ~340px of room for the label — show the full tmux
    // session name, not the elided display form used on HUD chips. The
    // chip ellision (`session.name`) exists only because the chip is
    // width-constrained; the palette isn't.
    const label = document.createElement('span')
    label.className = 'gs-label'
    label.textContent = fullName

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
      const isSelected = Number(item.dataset.index) === this.selectedIndex
      item.classList.toggle('selected', isSelected)
      item.setAttribute('aria-selected', isSelected ? 'true' : 'false')
    })
    const selected = this.results.querySelector<HTMLElement>(`.gs-item[data-index="${this.selectedIndex}"]`)
    selected?.scrollIntoView({ block: 'nearest' })
    if (selected?.id) {
      this.input.setAttribute('aria-activedescendant', selected.id)
    } else if (selected) {
      selected.id = `gs-option-${this.selectedIndex}`
      this.input.setAttribute('aria-activedescendant', selected.id)
    }
  }

  private activateSelection(index: number): void {
    const result = this.filteredResults[index]
    if (!result) return
    this.hide()
    if (result.type === 'city') {
      this.onSelectCity(result.city)
      return
    }
    if (result.type === 'fiber') {
      this.onSelectFiber?.(result.hit)
      return
    }
    this.onSelectWorker(result.session)
  }

  /**
   * Debounced fiber search. Re-renders synchronously once the response
   * lands; a stale resolution from a fast typer is filtered in renderResults
   * (we hold the last query that produced the cached hits in `fiberQuery`).
   */
  private scheduleFiberSearch(): void {
    if (!this.searchFibers) return
    if (this.fiberDebounceTimer !== null) {
      clearTimeout(this.fiberDebounceTimer)
      this.fiberDebounceTimer = null
    }
    const query = this.input.value.trim().toLowerCase()
    if (!query) {
      // Empty query: clear stale hits and re-render so the Fibers section
      // disappears immediately rather than waiting out the debounce.
      this.fiberHits = []
      this.fiberQuery = ''
      this.fiberLoading = false
      this.renderResults()
      return
    }
    this.fiberLoading = true
    this.fiberDebounceTimer = setTimeout(() => {
      this.fiberDebounceTimer = null
      const search = this.searchFibers
      if (!search) return
      // Snapshot the query at fire time — by the time the Promise resolves,
      // the user may have typed more. We compare against the live input
      // value before adopting the result.
      const fired = this.input.value.trim().toLowerCase()
      if (!fired) {
        this.fiberHits = []
        this.fiberQuery = ''
        this.fiberLoading = false
        return
      }
      void search(fired).then(
        (hits) => {
          // The palette may have been hidden, or the user may have moved on
          // to a different query — only adopt if the latest input still
          // matches what we fired. Stale resolutions are dropped silently.
          if (!this.visible) return
          const live = this.input.value.trim().toLowerCase()
          if (live !== fired) return
          this.fiberHits = hits
          this.fiberQuery = fired
          this.fiberLoading = false
          this.renderResults()
        },
        (err) => {
          // Network failure or 5xx: log, clear loading, leave whatever
          // hits the previous successful query produced (better than going
          // blank on a transient blip).
          console.warn('[GlobalSearchPalette] fiber search failed:', err)
          if (!this.visible) return
          const live = this.input.value.trim().toLowerCase()
          if (live !== fired) return
          this.fiberLoading = false
          this.renderResults()
        },
      )
    }, GlobalSearchPalette.FIBER_DEBOUNCE_MS)
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

      /* Origin suffix for cities sharing a name with another project
         (e.g. a local + remote ai-futures). Mirrors the map label
         .city-label-origin in 2d9c75d so the palette and map read the
         same way. */
      .gs-city .gs-city-origin {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10.5px;
        font-weight: 400;
        letter-spacing: 0.04em;
        color: var(--ink-faded, #7A6F5C);
        margin-left: 8px;
        vertical-align: baseline;
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

      /* ── Section header (between cities/workers and fibers) ── */
      .gs-section-header {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        color: var(--ink-faded, #7A7068);
        padding: 9px 14px 4px 14px;
        margin-top: 4px;
        border-top: 1px solid var(--parchment-edge, #BBA890);
        opacity: 0.7;
        animation: gs-fade-in 180ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
      }

      /* ── Fiber loading placeholder ── */
      .gs-fiber-loading {
        padding: 8px 14px;
        font-style: italic;
        font-size: 12px;
        color: var(--ink-faded, #7A7068);
        opacity: 0.65;
        animation: gs-fade-in 180ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
      }

      /* ── Fiber row ── */
      .gs-fiber {
        padding: 7px 14px;
        gap: 9px;
        align-items: flex-start;
      }

      .gs-fiber .gs-icon-fiber {
        width: 14px;
        height: 18px;
        font-size: 10px;
        line-height: 18px;
        color: var(--rust, #8A5548);
        opacity: 0.55;
        transition: opacity 100ms ease, color 100ms ease;
      }

      .gs-fiber-main {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
        gap: 1px;
      }

      .gs-fiber-title {
        font-size: 14px;
        color: var(--ink-dark, #2A2520);
        letter-spacing: 0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .gs-fiber-meta {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 10px;
        color: var(--ink-faded, #7A6F5C);
        letter-spacing: 0.04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .gs-fiber-snippet {
        font-size: 11.5px;
        color: var(--ink-light, #5A524A);
        font-style: italic;
        line-height: 1.35;
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Fiber selected: rust accent (matches the worker register since
         fibers also lean into rust in vellum's chrome) but slightly darker
         to keep the color distinct from selected workers. */
      .gs-fiber.selected {
        background: rgba(138, 85, 72, 0.08);
      }

      .gs-fiber.selected::after {
        content: '';
        position: absolute;
        left: 0; top: 2px; bottom: 2px;
        width: 2.5px;
        background: var(--rust, #8A5548);
        border-radius: 0 2px 2px 0;
      }

      .gs-fiber.selected .gs-icon-fiber {
        opacity: 1;
      }
    `
    document.head.appendChild(style)
  }
}
