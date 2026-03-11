import { escapeHtml } from './utils'
import { shortName, statusIcon, stalenessColor } from './tapestry-helpers'
import type { TapestryFiber, TapestryNode, TapestryResponse } from './tapestry-types'

const SEARCH_SNIPPET_CONTEXT = 15

type TapestrySidebarOptions = {
  searchInput: HTMLInputElement
  searchResults: HTMLElement
  fiberResultsEl: HTMLElement
  getData: () => TapestryResponse | null
  setSearchMatches: (matches: Set<string>) => void
  selectListedNode: (fiberId: string) => void
  selectSearchNode: (fiberId: string) => void
  selectFiber: (fiberId: string) => void
}

export class TapestrySidebar {
  private searchInput: HTMLInputElement
  private searchResults: HTMLElement
  private fiberResultsEl: HTMLElement
  private getData: () => TapestryResponse | null
  private setSearchMatches: (matches: Set<string>) => void
  private selectListedNode: (fiberId: string) => void
  private selectSearchNode: (fiberId: string) => void
  private selectFiber: (fiberId: string) => void
  private searchFocusIdx = -1

  constructor(options: TapestrySidebarOptions) {
    this.searchInput = options.searchInput
    this.searchResults = options.searchResults
    this.fiberResultsEl = options.fiberResultsEl
    this.getData = options.getData
    this.setSearchMatches = options.setSearchMatches
    this.selectListedNode = options.selectListedNode
    this.selectSearchNode = options.selectSearchNode
    this.selectFiber = options.selectFiber

    this.searchInput.addEventListener('input', this.handleInput)
    this.searchInput.addEventListener('keydown', this.handleKeydown)
  }

  reset(): void {
    this.searchInput.value = ''
    this.searchResults.innerHTML = ''
    this.searchFocusIdx = -1
    this.clearSearchHighlights()
  }

  renderFiberList(): void {
    const data = this.getData()
    if (!data) return
    const fibers = data.fibers || []
    const query = this.searchInput.value.toLowerCase().trim()
    const filtered = query
      ? fibers.filter((fiber) => {
          const text = [fiber.title, fiber.body, fiber.kind, fiber.id, fiber.outcome, ...(fiber.tags || [])]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          return text.includes(query)
        })
      : fibers

    const sorted = [...filtered].sort((a, b) => this.compareFibers(a, b, data))
    this.fiberResultsEl.innerHTML = sorted.map((fiber) => this.renderFiberItem(fiber, data)).join('')
    this.fiberResultsEl.querySelectorAll('.fiber-item').forEach((el) => {
      el.addEventListener('click', () => {
        const fiberId = (el as HTMLElement).dataset.fiberId
        if (!fiberId) return
        if (data.nodes.find((node) => node.id === fiberId)) {
          this.selectListedNode(fiberId)
        } else {
          this.selectFiber(fiberId)
        }
      })
    })
  }

  destroy(): void {
    this.searchInput.removeEventListener('input', this.handleInput)
    this.searchInput.removeEventListener('keydown', this.handleKeydown)
    this.reset()
  }

  private handleInput = (): void => {
    this.handleSearch()
    this.renderFiberList()
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.reset()
      this.searchInput.blur()
      this.renderFiberList()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
      if (results.length === 0) return
      this.searchFocusIdx = e.key === 'ArrowDown'
        ? (this.searchFocusIdx + 1) % results.length
        : this.searchFocusIdx <= 0 ? results.length - 1 : this.searchFocusIdx - 1
      this.updateSearchFocus()
      return
    }
    if (e.key === 'Enter') {
      const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
      if (this.searchFocusIdx >= 0 && this.searchFocusIdx < results.length) {
        results[this.searchFocusIdx].click()
      }
    }
  }

  private handleSearch(): void {
    const query = this.searchInput.value.toLowerCase().trim()
    this.clearSearchHighlights()
    this.searchResults.innerHTML = ''
    this.searchFocusIdx = -1

    const data = this.getData()
    if (!query || !data) return

    const matches: Array<{ node: TapestryNode; context: string }> = []
    data.nodes.forEach((node) => {
      const searchText = [node.title, node.body, node.kind, node.id].filter(Boolean).join(' ').toLowerCase()
      if (!searchText.includes(query)) return
      const idx = searchText.indexOf(query)
      const start = Math.max(0, idx - SEARCH_SNIPPET_CONTEXT)
      const end = Math.min(searchText.length, idx + query.length + SEARCH_SNIPPET_CONTEXT)
      let snippet = searchText.substring(start, end)
      if (start > 0) snippet = '...' + snippet
      if (end < searchText.length) snippet += '...'
      matches.push({ node, context: snippet })
    })

    this.setSearchMatches(new Set(matches.map((match) => match.node.id)))

    if (matches.length === 0) {
      this.searchResults.innerHTML = '<div class="search-no-results">no matches</div>'
      return
    }

    matches.forEach((match) => {
      const color = stalenessColor(match.node.staleness)
      const div = document.createElement('div')
      div.className = 'search-result'
      div.innerHTML = `
        <span class="search-result-dot" style="background: ${color}"></span>
        <span class="search-result-name">${escapeHtml(shortName(match.node.title))}</span>
        <span class="search-result-match">${escapeHtml(match.context)}</span>
      `
      div.addEventListener('click', () => {
        this.selectSearchNode(match.node.id)
        this.reset()
        this.renderFiberList()
      })
      this.searchResults.appendChild(div)
    })
  }

  private clearSearchHighlights(): void {
    this.setSearchMatches(new Set())
  }

  private updateSearchFocus(): void {
    const results = this.searchResults.querySelectorAll<HTMLElement>('.search-result')
    results.forEach((result, index) => result.classList.toggle('search-focused', index === this.searchFocusIdx))
    if (this.searchFocusIdx >= 0 && this.searchFocusIdx < results.length) {
      results[this.searchFocusIdx].scrollIntoView({ block: 'nearest' })
    }
  }

  private compareFibers(a: TapestryFiber, b: TapestryFiber, data: TapestryResponse): number {
    const aRule = this.isRule(a) ? 0 : 1
    const bRule = this.isRule(b) ? 0 : 1
    if (aRule !== bRule) return aRule - bRule
    if (aRule === 0 && bRule === 0) {
      const stalenessOrder: Record<string, number> = { stale: 0, 'no-evidence': 1, fresh: 2 }
      const aDag = data.nodes.find((node) => node.id === a.id)
      const bDag = data.nodes.find((node) => node.id === b.id)
      const aStaleness = stalenessOrder[aDag?.staleness || 'no-evidence'] ?? 1
      const bStaleness = stalenessOrder[bDag?.staleness || 'no-evidence'] ?? 1
      if (aStaleness !== bStaleness) return aStaleness - bStaleness
    }
    const statusOrder: Record<string, number> = { active: 0, open: 1, untracked: 2, closed: 3 }
    const aStatus = statusOrder[a.status] ?? 2
    const bStatus = statusOrder[b.status] ?? 2
    if (aStatus !== bStatus) return aStatus - bStatus
    return a.title.localeCompare(b.title)
  }

  private renderFiberItem(fiber: TapestryFiber, data: TapestryResponse): string {
    const dagNode = data.nodes.find((node) => node.id === fiber.id)
    const ruleTag = this.isRule(fiber)
    const dotColor = dagNode ? stalenessColor(dagNode.staleness) : '#7A7368'
    const dotIcon = statusIcon(fiber.status)
    const nonRuleTags = (fiber.tags || []).filter((tag) => !tag.startsWith('tapestry:'))
    const tagsHtml = nonRuleTags.map((tag) =>
      `<span class="fiber-tag">${escapeHtml(tag.replace(/^\[|\]$/g, ''))}</span>`
    ).join('')
    const kindBadge = fiber.kind !== 'task' ? `<span class="fiber-kind">${escapeHtml(fiber.kind)}</span>` : ''
    const ruleClass = ruleTag ? ' fiber-item-rule' : ''
    return `<div class="fiber-item${ruleClass}" data-fiber-id="${escapeHtml(fiber.id)}">
      <span class="fiber-dot" style="color: ${dotColor}">${dotIcon}</span>
      <span class="fiber-title">${escapeHtml(shortName(fiber.title))}</span>
      ${tagsHtml}${kindBadge}
    </div>`
  }

  private isRule(fiber: TapestryFiber): boolean {
    return fiber.tags?.some((tag) => tag.startsWith('tapestry:')) ?? false
  }
}
