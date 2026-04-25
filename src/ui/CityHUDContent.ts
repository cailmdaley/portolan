import type { City } from '../state/types'
import { CityHUDSearch } from './CityHUDSearch'
import { escapeHtml, fiberStatusIcon } from './utils'
import type { Fiber } from './hud-types'

interface FibersResponse {
  type: 'fibers'
  cityId: string
  open: Fiber[]
  closed: Fiber[]
}

type HudTab = 'fibers' | 'files'

interface CityHUDContentHost {
  sidebar: HTMLElement
  fiberList: HTMLElement
  filesList: HTMLElement
  searchInput: HTMLInputElement
  searchClear: HTMLElement
  searchResultsList: HTMLElement
  getCurrentCity: () => City | null
  getCurrentTab: () => HudTab
  getWebSocket: () => WebSocket | null
  getOnOpenFile: () => ((fullPath: string, originId: string, cityPath: string, cityId: string, line?: number) => void) | null
  getOnOpenDirectory: () => ((fullPath: string, originId: string, cityPath: string, cityId: string) => void) | null
  getOnPinnedFiberHover: () => ((slug: string | null) => void) | null
  renderEmptyFileSearchState: () => void
}

export class CityHUDContent {
  private host: CityHUDContentHost
  private openFibers: Fiber[] = []
  private closedFibers: Fiber[] = []
  // The cityId most recently asked for via `requestFibers`. The response
  // handler matches on this rather than on `host.getCurrentCity()` so the
  // fibers still land in the DOM even when show() → openCityWorkspace
  // clears currentCity before the response arrives (the cold-load
  // `#city=X` path). See `hud-fiber-loading-stuck`.
  private lastRequestedCityId: string | null = null
  private pinnedSlugs: Set<string> = new Set()
  private search: CityHUDSearch
  // Expanded container fiber IDs. Default is collapsed; user expands
  // explicitly. State is per-session, not per-city — small cost, lets you
  // navigate between cities without losing the tree shape you just opened.
  private expanded: Set<string> = new Set()
  // Active fiber-search query (lowercased substring). When set, the tree
  // is pruned to matches + their ancestors, ancestors auto-expand, and
  // matches get a tinted background. Cleared by clearing the search input.
  private fiberSearchQuery = ''
  // Per-render derived from fiberSearchQuery. searchMatchIds drives the
  // `search-match` tint; searchForceExpanded keeps ancestors open during
  // search without disturbing the user's manual expanded state.
  private searchMatchIds: Set<string> | null = null
  private searchForceExpanded: Set<string> | null = null

  constructor(host: CityHUDContentHost) {
    this.host = host
    this.search = new CityHUDSearch({
      sidebar: this.host.sidebar,
      fiberList: this.host.fiberList,
      filesList: this.host.filesList,
      searchInput: this.host.searchInput,
      searchClear: this.host.searchClear,
      searchResultsList: this.host.searchResultsList,
      getCurrentCity: () => this.host.getCurrentCity(),
      getCurrentTab: () => this.host.getCurrentTab(),
      getWebSocket: () => this.host.getWebSocket(),
      onOpenFile: (fullPath, line) => this.openFile(fullPath, line),
      onOpenDirectory: (fullPath) => this.openDirectory(fullPath),
      renderEmptyFileSearchState: () => this.host.renderEmptyFileSearchState(),
      onFiberSearchChange: (query) => this.setFiberSearchQuery(query),
    })
    this.setupDelegatedListeners()
  }

  reset(): void {
    this.openFibers = []
    this.closedFibers = []
    this.lastRequestedCityId = null
    this.search.reset()
    this.host.fiberList.innerHTML = ''
  }

  handleTabChange(tab: HudTab): void {
    this.search.handleTabChange(tab)
  }

  hasSearchActivity(): boolean {
    return this.search.hasActivity()
  }

  getRuntimeStats(): {
    openFibers: number
    closedFibers: number
    searchQueryLength: number
    pendingSearchResults: number
  } {
    return {
      openFibers: this.openFibers.length,
      closedFibers: this.closedFibers.length,
      ...this.search.getRuntimeStats(),
    }
  }

  getFibers(): { open: Fiber[]; closed: Fiber[] } {
    return {
      open: this.openFibers,
      closed: this.closedFibers,
    }
  }

  setPinnedSlugs(slugs: Set<string>): void {
    this.pinnedSlugs = slugs
    if (this.openFibers.length || this.closedFibers.length) {
      this.renderFibers(this.openFibers, this.closedFibers)
    }
  }

  requestFibers(cityId: string): void {
    const ws = this.host.getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.host.fiberList.innerHTML = '<li class="hud-fiber-empty">No connection</li>'
      return
    }

    this.lastRequestedCityId = cityId
    this.host.fiberList.innerHTML = '<li class="hud-fiber-empty hud-fiber-loading">Loading…</li>'
    ws.send(JSON.stringify({ type: 'getFibers', cityId }))
  }

  handleMessage(message: unknown): boolean {
    const msg = message as { type?: string }
    if (msg.type === 'fibers') {
      // Match on `lastRequestedCityId`, not `getCurrentCity()`. The cold-load
      // `#city=X` path calls show(X) (which sets currentCity and fires
      // requestFibers) and then immediately cityPanel.hide() (which clears
      // currentCity) before handing off to openCityWorkspace. Gating on
      // currentCity dropped the response on the floor in that window, leaving
      // the HUD permanently "Loading…" even after the workspace was closed.
      // The requested cityId is the right gate: we always want the response
      // to our most recent request. Stale responses (user switched cities
      // mid-flight) still get dropped because lastRequestedCityId advances.
      const response = message as FibersResponse
      if (response.cityId === this.lastRequestedCityId) {
        this.renderFibers(response.open, response.closed)
      }
      return true
    }
    if (msg.type === 'searchResults') {
      return this.search.handleMessage(message)
    }
    return false
  }

  clearSearch(): void {
    this.search.clear()
  }

  private setFiberSearchQuery(query: string): void {
    if (query === this.fiberSearchQuery) return
    this.fiberSearchQuery = query
    if (this.openFibers.length || this.closedFibers.length) {
      this.renderFibers(this.openFibers, this.closedFibers)
    }
  }

  private setupDelegatedListeners(): void {
    // HUD→map pin hover bridge: when the cursor passes over a pinned fiber
    // entry (either in the open fiber list or a search result), lift its
    // corresponding card on the map. Closes the HUD↔map coherence loop that
    // the `pinned` badge established visually — see tapestry-dissolves.
    // mouseover/mouseout bubble, so a single listener on the sidebar covers
    // both fiberList and searchResultsList.
    let hoveredPinnedSlug: string | null = null
    const setHoveredPinned = (slug: string | null): void => {
      if (slug === hoveredPinnedSlug) return
      hoveredPinnedSlug = slug
      this.host.getOnPinnedFiberHover()?.(slug)
    }
    this.host.sidebar.addEventListener('mouseover', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('.hud-fiber-item.pinned')
      setHoveredPinned(item?.dataset.fiberId ?? null)
    })
    this.host.sidebar.addEventListener('mouseout', (event) => {
      // If the relatedTarget (where the cursor moved to) is still inside a
      // pinned item, mouseover will handle the transition. Only clear when
      // leaving pinned items entirely.
      const related = event.relatedTarget as HTMLElement | null
      if (related?.closest?.('.hud-fiber-item.pinned')) return
      setHoveredPinned(null)
    })

    this.host.fiberList.addEventListener('click', (event) => {
      const target = event.target as HTMLElement

      const chevron = target.closest<HTMLElement>('.hud-fiber-chevron')
      if (chevron) {
        event.stopPropagation()
        const fiberId = chevron.dataset.fiberId
        if (fiberId) this.toggleCollapsed(fiberId)
        return
      }

      const handoff = target.closest<HTMLElement>('.hud-fiber-handoff')
      if (handoff) {
        event.stopPropagation()
        const fiberId = handoff.dataset.fiberId
        const currentCity = this.host.getCurrentCity()
        const ws = this.host.getWebSocket()
        if (fiberId && currentCity && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'handoff',
            fiberId,
            cityPath: currentCity.path,
          }))
        }
        return
      }

      const item = target.closest<HTMLElement>('.hud-fiber-item')
      if (!item) return
      this.openFiber(item.dataset.fiberId)
    })
  }

  private toggleCollapsed(fiberId: string): void {
    if (this.expanded.has(fiberId)) {
      this.expanded.delete(fiberId)
    } else {
      this.expanded.add(fiberId)
    }
    this.renderFibers(this.openFibers, this.closedFibers)
  }

  private renderFibers(open: Fiber[], closed: Fiber[]): void {
    this.openFibers = open
    this.closedFibers = closed

    const allFibers = [...open, ...closed]
    if (allFibers.length === 0) {
      this.host.fiberList.innerHTML = '<li class="hud-fiber-empty">No fibers</li>'
      return
    }

    // Search prunes the tree to (matches ∪ ancestors). Ancestors come along
    // as scaffolding — without them the matched leaves would lose their
    // context. Matches get a tinted background; ancestors stay plain.
    const matchIds = this.computeMatchIds(allFibers)
    const visibleIds = matchIds ? this.expandWithAncestors(allFibers, matchIds) : null
    const rendered = visibleIds ? allFibers.filter(f => visibleIds.has(f.id)) : allFibers
    this.searchMatchIds = matchIds
    // Force-expand every ancestor of a match so the matches are actually
    // visible. User's manual expanded state is restored when search clears.
    this.searchForceExpanded = visibleIds && matchIds
      ? new Set(Array.from(visibleIds).filter(id => !matchIds.has(id)))
      : null

    if (rendered.length === 0) {
      this.host.fiberList.innerHTML = '<li class="hud-fiber-empty">No matches</li>'
      return
    }

    // Root fiber (entry-point, bare `.felt/<slug>.md`) renders first as a
    // distinct section. Everything else forms a tree keyed by parentId —
    // top-level folder-fibers (parentId null) are tree roots beneath.
    const rootFiber = rendered.find(f => f.isRoot)
    const rest = rootFiber ? rendered.filter(f => f !== rootFiber) : rendered

    // An orphan is a nested fiber whose parent isn't in the current list
    // (typically because the parent is closed). Render those at top level
    // — otherwise they'd vanish entirely. Include the root's id in
    // `presentIds` so fibers nested under `.felt/<root>/<slug>/` (whose
    // parentId is the root's id) are correctly recognized as root-children
    // rather than treated as orphans and flattened to the top level. Without
    // this, the loom shape `~/loom/.felt/<container>/<root>/<root>/<slug>`
    // produced "singletons" — root-children appearing alongside top-level
    // folder fibers, indistinguishable from real top-level entries.
    const presentIds = new Set(rest.map(f => f.id))
    if (rootFiber) presentIds.add(rootFiber.id)
    const childrenByParent = new Map<string | null, Fiber[]>()
    for (const fiber of rest) {
      const rawParent = fiber.parentId ?? null
      const parent = rawParent !== null && !presentIds.has(rawParent) ? null : rawParent
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
      childrenByParent.get(parent)!.push(fiber)
    }

    // Within each subtree level, sort by status priority then by name.
    // active comes first (live work); closed sinks to the bottom (done, but
    // still visible inside its parent so the tree stays meaningful).
    for (const siblings of childrenByParent.values()) {
      siblings.sort((a, b) => {
        const rankDelta = statusRank(a.status) - statusRank(b.status)
        if (rankDelta !== 0) return rankDelta
        return a.name.localeCompare(b.name)
      })
    }

    const html: string[] = []
    if (rootFiber) {
      const rootChildren = childrenByParent.get(rootFiber.id) ?? []
      const rootHasChildren = rootChildren.length > 0
      html.push(this.renderFiberItem(rootFiber, 0, rootHasChildren, /*isRoot*/ true))
      // Root's own children (e.g. `.felt/<root>/<slug>/`) nest one level
      // beneath it, with the same expand/collapse behaviour as any other
      // container. They live conceptually inside the root, not alongside
      // the top-level folder fibers.
      const rootExpanded = this.expanded.has(rootFiber.id) || (this.searchForceExpanded?.has(rootFiber.id) ?? false)
      if (rootHasChildren && rootExpanded) {
        html.push(...this.renderFiberSubtree(rootFiber.id, childrenByParent, 1))
      }
    }
    html.push(...this.renderFiberSubtree(null, childrenByParent, 0))
    this.host.fiberList.innerHTML = html.join('')
  }

  private computeMatchIds(fibers: Fiber[]): Set<string> | null {
    const q = this.fiberSearchQuery.toLowerCase()
    if (!q) return null
    const hit = (s: string | undefined) => s?.toLowerCase().includes(q) ?? false
    const matches = new Set<string>()
    for (const f of fibers) {
      if (
        hit(f.name) || hit(f.kind) || hit(f.id) ||
        hit(f.body) || hit(f.outcome) || hit(f.reason) ||
        (f.tags?.some(tag => hit(tag)) ?? false)
      ) {
        matches.add(f.id)
      }
    }
    return matches
  }

  private expandWithAncestors(fibers: Fiber[], matchIds: Set<string>): Set<string> {
    const byId = new Map(fibers.map(f => [f.id, f]))
    const visible = new Set(matchIds)
    for (const id of matchIds) {
      let parentId = byId.get(id)?.parentId ?? null
      while (parentId && !visible.has(parentId)) {
        visible.add(parentId)
        parentId = byId.get(parentId)?.parentId ?? null
      }
    }
    return visible
  }

  private renderFiberSubtree(
    parentId: string | null,
    childrenByParent: Map<string | null, Fiber[]>,
    depth: number,
  ): string[] {
    const children = childrenByParent.get(parentId) ?? []
    const out: string[] = []
    for (const fiber of children) {
      const hasChildren = (childrenByParent.get(fiber.id)?.length ?? 0) > 0
      out.push(this.renderFiberItem(fiber, depth, hasChildren, false))
      const isExpanded = this.expanded.has(fiber.id) || (this.searchForceExpanded?.has(fiber.id) ?? false)
      if (hasChildren && isExpanded) {
        out.push(...this.renderFiberSubtree(fiber.id, childrenByParent, depth + 1))
      }
    }
    return out
  }

  private renderFiberItem(fiber: Fiber, depth: number, hasChildren: boolean, isRoot: boolean): string {
    const kind = fiber.kind || 'task'
    const classes = ['hud-fiber-item', kind]
    classes.push(`status-${fiber.status || 'unset'}`)
    if (this.pinnedSlugs.has(fiber.id)) classes.push('pinned')
    if (isRoot) classes.push('root')
    if (hasChildren) classes.push('has-children')
    if (this.searchMatchIds?.has(fiber.id)) classes.push('search-match')

    const isExpanded = this.expanded.has(fiber.id) || (this.searchForceExpanded?.has(fiber.id) ?? false)
    const chevron = hasChildren
      ? `<button class="hud-fiber-chevron${isExpanded ? '' : ' collapsed'}" data-fiber-id="${escapeHtml(fiber.id)}" title="${isExpanded ? 'Collapse' : 'Expand'}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} ${escapeHtml(fiber.name)}" aria-expanded="${isExpanded}">▾</button>`
      : `<span class="hud-fiber-chevron spacer" aria-hidden="true"></span>`

    const style = depth > 0 ? ` style="--fiber-depth: ${depth}"` : ''

    // Kind badge only carries information when kind is *not* the default
    // 'task' — rendering it on every row is noise. The .kind class on the
    // <li> still drives kind-specific color tokens (spec/decision/question/doc).
    const kindBadge = kind === 'task'
      ? ''
      : `<span class="hud-fiber-kind">${kind}</span>`

    // A11y: default accessible name is the concatenated text of all children,
    // which renders as "◐  Fiber name    ↗" with newlines and gutter
    // whitespace. Name the row by the fiber, and hide decorative chrome from
    // the a11y tree so screen readers announce just "Fiber name — <status>".
    // The title itself is a <button> so keyboard users can open the fiber —
    // chevron only toggles expand and handoff only sends to worker, so without
    // a focusable title there was no Tab-reachable Open action. The row's
    // delegated click still falls through to openFiber() when the title button
    // bubbles, so mouse users keep the full-row hit target.
    const ariaLabel = `${escapeHtml(fiber.name)} — ${fiber.status || 'open'}${kind === 'task' ? '' : ` (${kind})`}`
    return `
      <li class="${classes.join(' ')}" data-fiber-id="${escapeHtml(fiber.id)}" aria-label="${ariaLabel}"${style}>
        ${chevron}
        <span class="hud-fiber-status" aria-hidden="true">${fiberStatusIcon(fiber.status)}</span>
        <button type="button" class="hud-fiber-title" data-fiber-id="${escapeHtml(fiber.id)}" aria-label="Open ${escapeHtml(fiber.name)}">${escapeHtml(fiber.name)}</button>
        ${kindBadge}
        <button class="hud-fiber-handoff" data-fiber-id="${escapeHtml(fiber.id)}" title="Hand off to worker" aria-label="Hand off ${escapeHtml(fiber.name)} to worker">↗</button>
      </li>
    `
  }

  private openFiber(fiberId: string | undefined): void {
    const currentCity = this.host.getCurrentCity()
    const onOpenFile = this.host.getOnOpenFile()
    if (!fiberId || !currentCity || !onOpenFile) return
    // Nested fiber IDs are slash-joined (`foo/bar`); the file lives at
    // `.felt/foo/bar/bar.md`. Root fibers (entry-point) are bare at the
    // .felt/ root: `.felt/<slug>.md` — no enclosing directory.
    const fiber = this.openFibers.find(f => f.id === fiberId) ?? this.closedFibers.find(f => f.id === fiberId)
    const relPath = fiber?.isRoot
      ? `.felt/${fiberId}.md`
      : `.felt/${fiberId}/${fiberId.split('/').pop()}.md`
    onOpenFile(`${currentCity.path}/${relPath}`, currentCity.originId, currentCity.path, currentCity.id)
  }

  private openFile(fullPath: string | undefined, line?: number): void {
    const currentCity = this.host.getCurrentCity()
    const onOpenFile = this.host.getOnOpenFile()
    if (!fullPath || !currentCity || !onOpenFile) return
    onOpenFile(fullPath, currentCity.originId, currentCity.path, currentCity.id, line)
  }

  private openDirectory(fullPath: string | undefined): void {
    const currentCity = this.host.getCurrentCity()
    const onOpenDirectory = this.host.getOnOpenDirectory()
    if (!fullPath || !currentCity || !onOpenDirectory) return
    onOpenDirectory(fullPath, currentCity.originId, currentCity.path, currentCity.id)
  }
}

// Display order: active work first, then open, then statusless containers,
// then closed (sunk to the bottom but still visible — the tree handles
// access without needing a separate "recently closed" section).
function statusRank(status: string): number {
  switch (status) {
    case 'active': return 0
    case 'open': return 1
    case '': return 2
    case 'closed': return 3
    default: return 4
  }
}
