/**
 * Layer-1 contract tests: Shuttle daemon ↔ kanban modal dispatch flow.
 *
 * Tests mock the shuttle daemon's HTTP responses and drive the FiberDetailModal's
 * "Dispatch now" button end-to-end, asserting that the UI lands on the correct
 * state for each response code.
 *
 * Coverage:
 *   200 dispatched:true      → modal closes, onSaved called
 *   409 already_running      → button shows "Already running", info message shown
 *   422 not_eligible         → human-readable refusal message shown
 *   500 daemon error         → daemon's reason surfaced in error element
 *   Network / CORS failure   → "Couldn't reach daemon" message (not "Load failed")
 *
 * Plus unit tests for dispatchIneligibleReason() and the CORS preflight flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FiberDetailModal, KanbanModal, dispatchIneligibleReason } from './KanbanModal.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal KanbanCard with fields needed to show the Dispatch Now button. */
function makeInFlightCard(overrides: Partial<{
  id: string
  runningWorker: string
  shuttleKind: 'oneshot' | 'standing'
  sessionId: string
  shuttleFiberId: string
}> = {}) {
  return {
    id: 'test/my-constitution',
    name: 'My Constitution',
    path: 'test/my-constitution',
    originId: 'local',
    status: 'active',
    dependsOnSatisfied: true,
    createdAt: '2026-01-01T00:00:00Z',
    shuttleKind: 'oneshot' as const,
    shuttleAgent: 'claude-sonnet',
    shuttleFiberId: 'test/my-constitution',
    tags: ['constitution'],
    effectiveHorizon: 'now' as const,
    drifted: false,
    ...overrides,
  }
}

function makeKanbanCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test/my-constitution',
    name: 'My Constitution',
    path: 'test/my-constitution',
    originId: 'local',
    status: 'open',
    dependsOnSatisfied: true,
    createdAt: '2026-01-01T00:00:00Z',
    tags: ['constitution'],
    effectiveHorizon: 'now' as const,
    drifted: false,
    ...overrides,
  }
}

function renderGridCard(
  overrides: Record<string, unknown> = {},
  kind: 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered' = 'drafts',
): {
  el: HTMLElement
  detailOpen: ReturnType<typeof vi.fn>
} {
  const modal = new KanbanModal({
    apiBase: 'http://localhost:4004',
    onOpenFiber: vi.fn(),
  })
  const detailOpen = vi.fn()
  ;(modal as unknown as { detailModal: { open: ReturnType<typeof vi.fn> } }).detailModal = {
    open: detailOpen,
  }
  const el = (modal as unknown as {
    renderCard: (
      card: ReturnType<typeof makeKanbanCard>,
      kind: 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered'
    ) => HTMLElement
  }).renderCard(makeKanbanCard(overrides), kind)
  document.body.append(el)
  return { el, detailOpen }
}

/**
 * Build a mock `fetch` that returns preset responses keyed by URL substring.
 * Any URL not matched returns 200 with an empty JSON body.
 */
function mockFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn((url: string | URL | Request) => {
    const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
    for (const [pattern, handler] of Object.entries(routes)) {
      if (urlStr.includes(pattern)) return Promise.resolve(handler())
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function emptyKanbanResponse() {
  return {
    feltHost: '/tmp/felt',
    now: {
      drafts: [] as ReturnType<typeof makeKanbanCard>[],
      inFlight: [] as ReturnType<typeof makeKanbanCard>[],
      awaitingReview: [] as ReturnType<typeof makeKanbanCard>[],
    },
    timeline: {
      past: [] as ReturnType<typeof makeKanbanCard>[],
      futureDated: [] as ReturnType<typeof makeKanbanCard>[],
      anytimeSoon: [] as ReturnType<typeof makeKanbanCard>[],
    },
    stash: [] as ReturnType<typeof makeKanbanCard>[],
    ideas: [] as ReturnType<typeof makeKanbanCard>[],
    totals: {
      ideas: 0,
      drafts: 0,
      inFlight: 0,
      awaitingReview: 0,
      past: 0,
      futureDated: 0,
      anytimeSoon: 0,
      stash: 0,
    },
    temperedTotal: 0,
    staleness: { local: { status: 'fresh' } },
    shuttleDiagnostics: {
      remoteSnapshots: [] as Array<{
        originId: string
        receivedAt: string
        eligibleCount: number | null
        blockedCount: number | null
        orphanCount: number | null
      }>,
    },
  }
}

/** Wait one microtask tick for async handlers to settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function mockDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    setData(type: string, value: string) { data.set(type, value) },
    getData(type: string) { return data.get(type) ?? '' },
  } as DataTransfer
}

function dispatchDrag(target: Element, type: string, dataTransfer: DataTransfer): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  target.dispatchEvent(event)
}

function installLocalStorageMock(): void {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    },
  })
}

/**
 * Mount a FiberDetailModal in 'inFlight' mode and return the dispatch
 * button and error element. The dispatch button only appears when
 * columnKind === 'inFlight' AND card.shuttleKind is defined AND
 * card.runningWorker is falsy.
 */
async function openDispatchModal(card: ReturnType<typeof makeInFlightCard>): Promise<{
  modal: FiberDetailModal
  dispatchBtn: HTMLButtonElement
  resumeBtn: HTMLButtonElement
  directiveTa: HTMLTextAreaElement
  errorEl: HTMLElement
  onSaved: ReturnType<typeof vi.fn>
}> {
  const onSaved = vi.fn()
  const modal = new FiberDetailModal(
    'http://localhost:4004',
    vi.fn(),
    onSaved,
  )
  modal.open(card, undefined, 'inFlight')
  // Let async loadAgents / loadHistory settle (they're fire-and-forget voids).
  await tick()

  const primaryBtns = document.querySelectorAll('.kbn-detail-action-primary') as NodeListOf<HTMLButtonElement>
  const dispatchBtn = primaryBtns[0]
  if (!dispatchBtn) throw new Error('Resubmit button not found — card may not be inFlight or shuttleKind is missing')
  const resumeBtn = primaryBtns[1]
  if (!resumeBtn) throw new Error('Resume button not found')

  const directiveTa = document.querySelector('.kbn-detail-directive') as HTMLTextAreaElement | null
  if (!directiveTa) throw new Error('Directive textarea not found')

  // The error element follows the actions section — same actionsErr shared by
  // all action buttons. We pick the first kbn-detail-error in the actions section.
  const errors = document.querySelectorAll('.kbn-detail-error')
  // actionsErr is the first one created (before tagsErr), so index 0.
  const errorEl = errors[0] as HTMLElement
  if (!errorEl) throw new Error('Error element not found')

  return { modal, dispatchBtn, resumeBtn, directiveTa, errorEl, onSaved }
}

async function openPromoteModal(card: ReturnType<typeof makeKanbanCard> = makeKanbanCard({ due: '2026-05-20' })): Promise<{
  modal: FiberDetailModal
  promoteBtn: HTMLButtonElement
  agentSelect: HTMLSelectElement
  errorEl: HTMLElement
  onSaved: ReturnType<typeof vi.fn>
}> {
  const onSaved = vi.fn()
  const modal = new FiberDetailModal(
    'http://localhost:4004',
    vi.fn(),
    onSaved,
  )
  modal.open(card, undefined, 'drafts')
  await tick()

  const promoteBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.kbn-detail-action-btn'))
    .find((candidate) => candidate.textContent?.trim() === 'Promote to shuttle')
  if (!promoteBtn) throw new Error('Promote button not found')
  const agentSelect = document.querySelector('#kbn-detail-agent') as HTMLSelectElement | null
  if (!agentSelect) throw new Error('Agent select not found')
  const errorEl = document.querySelector('.kbn-detail-section[data-section="promote to shuttle"] .kbn-detail-error') as HTMLElement | null
  if (!errorEl) throw new Error('Promote error element not found')

  return { modal, promoteBtn, agentSelect, errorEl, onSaved }
}

function detailActionButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.kbn-detail-action-btn'))
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!btn) throw new Error(`${label} button not found`)
  return btn
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Clean DOM between tests.
  document.body.innerHTML = ''
  installLocalStorageMock()
  // Reset fetch mock.
  vi.unstubAllGlobals()
})

afterEach(() => {
  // Remove any overlays the modal appended.
  document.querySelectorAll('.kbn-detail-overlay').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

// ── Chrome ──────────────────────────────────────────────────────────────────

describe('KanbanModal chrome', () => {
  it('does not render the old constitution-tagged subtitle in global scope', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(emptyKanbanResponse()),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    expect(host.querySelector('.kbn-subtitle')?.textContent).toBe('')
    expect(host.textContent).not.toContain('constitution-tagged fibers')
    modal.unmount()
    host.remove()
  })

  it('uses the subtitle only as a city scope cue', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(emptyKanbanResponse()),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host, { cityScope: { cityId: 'city-lightcone', cityName: 'Lightcone' } })
    await tick()

    expect(host.querySelector('.kbn-subtitle')?.textContent).toBe('Lightcone')
    expect(host.textContent).not.toContain('constitution-tagged fibers')
    modal.unmount()
    host.remove()
  })
})

// ── Horizon rows ────────────────────────────────────────────────────────────

describe('KanbanModal three-surface layout', () => {
  it('renders Now, Timeline, and Stash sections top-to-bottom', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(emptyKanbanResponse()),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    const sections = host.querySelectorAll('.kbn-section')
    expect(sections).toHaveLength(3)
    expect(sections[0].classList.contains('kbn-section-now')).toBe(true)
    expect(sections[1].classList.contains('kbn-section-timeline')).toBe(true)
    expect(sections[2].classList.contains('kbn-section-stash')).toBe(true)

    // Now-board has exactly the three lifecycle columns.
    const nowCols = host.querySelectorAll('.kbn-section-now .kbn-col')
    expect(nowCols).toHaveLength(3)
    expect(nowCols[0].getAttribute('data-column')).toBe('drafts')
    expect(nowCols[1].getAttribute('data-column')).toBe('inFlight')
    expect(nowCols[2].getAttribute('data-column')).toBe('awaitingReview')

    modal.unmount()
    host.remove()
  })

  it('renders Now cards in their server-assigned columns', async () => {
    const response = emptyKanbanResponse()
    response.now.drafts = [makeKanbanCard({ id: 'test/now-draft', name: 'Now draft' })]
    response.now.inFlight = [
      makeKanbanCard({
        id: 'test/now-active',
        name: 'Now active',
        storedHorizon: 'now',
        effectiveHorizon: 'now',
      }),
    ]
    response.totals = { ...response.totals, drafts: 1, inFlight: 1 }
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(response),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    expect(host.querySelector('.kbn-section-now .kbn-col-drafts')?.textContent).toContain('Now draft')
    expect(host.querySelector('.kbn-section-now .kbn-col-inFlight')?.textContent).toContain('Now active')

    modal.unmount()
    host.remove()
  })

  it('renders remote Shuttle diagnostics in the masthead status line', async () => {
    const response = emptyKanbanResponse()
    response.shuttleDiagnostics.remoteSnapshots = [{
      originId: 'remote-candide',
      receivedAt: new Date().toISOString(),
      eligibleCount: 2,
      blockedCount: 5,
      orphanCount: 1,
    }]
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(response),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    expect(host.querySelector('.kbn-status')?.textContent).toContain('Shuttle candide: 2/5/1')

    modal.unmount()
    host.remove()
  })

  it('renders a legacy native-bundled /kanban columns response', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse({
        feltHost: '/tmp/felt',
        columns: {
          drafts: [makeKanbanCard({ id: 'legacy/draft', name: 'Legacy draft' })],
          inFlight: [makeKanbanCard({ id: 'legacy/live', name: 'Legacy live' })],
          awaitingReview: [],
          tempered: [],
          composted: [],
        },
        totals: { drafts: 1, inFlight: 1, awaitingReview: 0 },
        temperedTotal: 0,
      }),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    expect(host.querySelector('.kbn-section-now .kbn-col-drafts')?.textContent).toContain('Legacy draft')
    expect(host.querySelector('.kbn-section-now .kbn-col-inFlight')?.textContent).toContain('Legacy live')

    modal.unmount()
    host.remove()
  })

  it('reports malformed /kanban payloads without throwing from render', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse({ ok: true }),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    expect(host.textContent).toContain('Failed to load kanban: Kanban response missing board columns')

    modal.unmount()
    host.remove()
  })

  it('renders timeline.past cards with composted variant when tempered=false', async () => {
    const today = new Date().toISOString()
    const response = emptyKanbanResponse()
    response.timeline.past = [
      makeKanbanCard({
        id: 'test/landed',
        name: 'Landed yesterday',
        closedAt: today,
        tempered: true,
      }),
      makeKanbanCard({
        id: 'test/composted',
        name: 'Composted',
        closedAt: today,
        tempered: false,
      }),
    ]
    response.totals = { ...response.totals, past: 2 }
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(response),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    const past = host.querySelector('[data-fiber-id="test/landed"]') as HTMLElement | null
    const composted = host.querySelector('[data-fiber-id="test/composted"]') as HTMLElement | null
    expect(past?.classList.contains('kbn-tl-card-past')).toBe(true)
    expect(composted?.classList.contains('kbn-tl-card-composted')).toBe(true)

    modal.unmount()
    host.remove()
  })

  it('only the timeline gets a collapse toggle; state persists to localStorage', async () => {
    // Drafts and Stash live above/below the timeline and are reachable
    // by scroll; only the in-between Past · Soon strip needs collapse.
    const response = emptyKanbanResponse()
    response.now.drafts = [makeKanbanCard({ id: 'draft/a' })]
    response.timeline.past = [makeKanbanCard({ id: 'past/a', closedAt: new Date().toISOString() })]
    response.stash = [makeKanbanCard({ id: 'stash/a' })]
    response.totals = { ...response.totals, drafts: 1, past: 1, stash: 1 }

    vi.stubGlobal('fetch', mockFetch({ '/kanban': () => jsonResponse(response) }))
    window.localStorage.removeItem('portolan:kanban:collapsed-sections')

    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({ apiBase: 'http://localhost:4004', onOpenFiber: vi.fn() })
    modal.mount(host)
    await tick()

    const toggles = host.querySelectorAll<HTMLButtonElement>('.kbn-section-toggle')
    expect(toggles).toHaveLength(1)
    expect(toggles[0].getAttribute('aria-label')).toBe('Collapse Past · Soon')

    toggles[0].click()
    const timelineSection = host.querySelector('.kbn-section-timeline')!
    expect(timelineSection.classList.contains('kbn-section-collapsed')).toBe(true)
    expect(toggles[0].getAttribute('aria-label')).toBe('Expand Past · Soon')
    const stored = JSON.parse(window.localStorage.getItem('portolan:kanban:collapsed-sections') ?? '[]')
    expect(stored).toContain('timeline')

    toggles[0].click()
    expect(timelineSection.classList.contains('kbn-section-collapsed')).toBe(false)
    const stored2 = JSON.parse(window.localStorage.getItem('portolan:kanban:collapsed-sections') ?? '[]')
    expect(stored2).not.toContain('timeline')

    modal.unmount()
    host.remove()
    window.localStorage.removeItem('portolan:kanban:collapsed-sections')
  })

  it('timeline cards stack within a day but share rows across days (no staircase)', async () => {
    // Regression: the strip is a CSS grid with explicit columns but no
    // explicit rows. If cards omit grid-row, sparse auto-placement
    // staircases them one-per-row (col 11 → row 1, col 10 → row 2, …).
    // Each card must carry an explicit grid-row computed from its
    // position within its day.
    const today = new Date()
    const isoDay = (d: Date) => {
      const tz = d.getTimezoneOffset() * 60_000
      return new Date(d.getTime() - tz).toISOString().slice(0, 10)
    }
    const dayAt = (offset: number) => {
      const d = new Date(today)
      d.setHours(12, 0, 0, 0)
      d.setDate(d.getDate() + offset)
      return d.toISOString()
    }

    const response = emptyKanbanResponse()
    // Past list is reverse-chronological — most recent first — which is
    // precisely the case that breaks sparse auto-placement.
    response.timeline.past = [
      makeKanbanCard({ id: 'past/d-1-a', name: 'd-1 a', closedAt: dayAt(-1) }),
      makeKanbanCard({ id: 'past/d-2-a', name: 'd-2 a', closedAt: dayAt(-2) }),
      makeKanbanCard({ id: 'past/d-3-a', name: 'd-3 a', closedAt: dayAt(-3) }),
      makeKanbanCard({ id: 'past/d-3-b', name: 'd-3 b', closedAt: dayAt(-3) }),
      makeKanbanCard({ id: 'past/d-3-c', name: 'd-3 c', closedAt: dayAt(-3) }),
    ]
    response.totals = { ...response.totals, past: 5 }
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(response),
    }))

    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })
    modal.mount(host)
    await tick()

    const row = (id: string) =>
      (host.querySelector(`[data-fiber-id="${id}"]`) as HTMLElement | null)?.style.gridRow
    // Singletons on their own day → row 1
    expect(row('past/d-1-a')).toBe('1')
    expect(row('past/d-2-a')).toBe('1')
    // Three cards on the same day stack 1, 2, 3
    expect(row('past/d-3-a')).toBe('1')
    expect(row('past/d-3-b')).toBe('2')
    expect(row('past/d-3-c')).toBe('3')

    // Sanity: distinct day columns differ
    const col = (id: string) =>
      (host.querySelector(`[data-fiber-id="${id}"]`) as HTMLElement | null)?.style.gridColumn
    expect(col('past/d-1-a')).not.toBe(col('past/d-2-a'))
    expect(col('past/d-2-a')).not.toBe(col('past/d-3-a'))
    void isoDay  // silence unused — kept for future per-iso assertions

    modal.unmount()
    host.remove()
  })

  it('places standing-role timeline cards at their nextLaunchAt day-column', async () => {
    // Dormant standing roles arrive on timeline.futureDated with
    // `nextLaunchAt` (cron-derived) instead of `due` (human-set). The
    // strip's day-column lookup reads `card.nextLaunchAt ?? card.due`, so
    // a standing role with nextLaunchAt 3 days out must land in the same
    // column as a human due-date card 3 days out.
    const today = new Date()
    const isoDay = (d: Date) => {
      const tz = d.getTimezoneOffset() * 60_000
      return new Date(d.getTime() - tz).toISOString().slice(0, 10)
    }
    const dayAt = (offset: number) => {
      const d = new Date(today)
      d.setHours(9, 0, 0, 0)
      d.setDate(d.getDate() + offset)
      return d.toISOString()
    }
    const day3 = new Date(today); day3.setDate(day3.getDate() + 3)
    const day3Iso = isoDay(day3)

    const response = emptyKanbanResponse()
    response.timeline.futureDated = [
      makeKanbanCard({
        id: 'standing/weekly',
        name: 'Weekly standing role',
        shuttleKind: 'standing',
        shuttleSchedule: '0 9 * * 1',
        shuttleTz: 'UTC',
        shuttleReviewState: 'scheduled',
        nextLaunchAt: dayAt(3),
      }),
      makeKanbanCard({
        id: 'human/deadline',
        name: 'Human due-date card',
        due: dayAt(3),
        storedHorizon: 'soon',
      }),
    ]
    response.totals = { ...response.totals, futureDated: 2 }
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(response),
    }))

    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })
    modal.mount(host)
    await tick()

    const standingCard = host.querySelector<HTMLElement>('[data-fiber-id="standing/weekly"]')
    const humanCard = host.querySelector<HTMLElement>('[data-fiber-id="human/deadline"]')
    expect(standingCard).not.toBeNull()
    expect(humanCard).not.toBeNull()
    // Both should land on the same day-column 3 days out.
    expect(standingCard?.style.gridColumn).toBe(humanCard?.style.gridColumn)
    // And that column should match the target day's iso.
    const dayCol = host.querySelector<HTMLElement>(`[data-timeline-day-iso="${day3Iso}"]`)
    expect(dayCol).not.toBeNull()

    modal.unmount()
    host.remove()
  })

  it('clusters stash cards by containment-path; held-open below warm', async () => {
    const response = emptyKanbanResponse()
    response.stash = [
      makeKanbanCard({ id: 'ai-futures/portolan/warm-one', name: 'Warm in portolan' }),
      makeKanbanCard({ id: 'ai-futures/portolan/warm-two', name: 'Also portolan' }),
      makeKanbanCard({ id: 'ai-futures/vellum-reader/held', name: 'Held open in vellum', cold: true }),
    ]
    response.totals = { ...response.totals, stash: 3 }
    vi.stubGlobal('fetch', mockFetch({
      '/kanban': () => jsonResponse(response),
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    const clusters = host.querySelectorAll('.kbn-cluster')
    expect(clusters.length).toBeGreaterThanOrEqual(2)
    // First cluster is the warm `portolan` (containment skips ai-futures).
    expect(clusters[0].getAttribute('data-cluster-key')).toBe('portolan')
    expect(clusters[0].classList.contains('kbn-cluster-cold')).toBe(false)
    // Held-open cluster appears after a divider, key `vellum-reader`, cold.
    const cold = host.querySelector('.kbn-cluster.kbn-cluster-cold')
    expect(cold?.getAttribute('data-cluster-key')).toBe('vellum-reader')
    expect(cold?.textContent).toContain('held open')

    modal.unmount()
    host.remove()
  })

  it('dragging a Now card into the stash posts /kanban/horizon with horizon=stashed', async () => {
    const response = emptyKanbanResponse()
    const card = makeKanbanCard({
      id: 'test/drag-to-stash',
      name: 'Drag to stash',
      shuttleKind: 'oneshot',
      shuttleAgent: 'pi-sonnet',
    })
    response.now.inFlight = [card]
    response.totals = { ...response.totals, inFlight: 1 }
    const horizonBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/horizon')) {
        horizonBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({
          ok: true,
          card: { ...card, storedHorizon: 'stashed', effectiveHorizon: 'stashed' },
        }))
      }
      if (urlStr.includes('/kanban')) return Promise.resolve(jsonResponse(response))
      return Promise.resolve(jsonResponse({}))
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    const cardEl = host.querySelector<HTMLElement>('[data-fiber-id="test/drag-to-stash"]')
    const stashSection = host.querySelector<HTMLElement>('.kbn-section-stash')
    if (!cardEl || !stashSection) throw new Error('drag fixtures not found')
    const dt = mockDataTransfer()
    dispatchDrag(cardEl, 'dragstart', dt)
    dispatchDrag(stashSection, 'drop', dt)
    await tick()
    await tick()

    expect(horizonBodies).toHaveLength(1)
    expect(horizonBodies[0]).toMatchObject({
      fiberId: 'test/drag-to-stash',
      horizon: 'stashed',
    })

    modal.unmount()
    host.remove()
  })

  it('dragging a Now card onto a future timeline date column posts horizon=soon + due', async () => {
    const response = emptyKanbanResponse()
    const card = makeKanbanCard({
      id: 'test/drag-to-timeline',
      name: 'Drag to timeline',
      shuttleKind: 'oneshot',
      shuttleAgent: 'pi-sonnet',
    })
    response.now.inFlight = [card]
    response.totals = { ...response.totals, inFlight: 1 }
    const horizonBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/horizon')) {
        horizonBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true, card }))
      }
      if (urlStr.includes('/kanban')) return Promise.resolve(jsonResponse(response))
      return Promise.resolve(jsonResponse({}))
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    const cardEl = host.querySelector<HTMLElement>('[data-fiber-id="test/drag-to-timeline"]')
    // Pick a future-day drop column 3 days out.
    const future = new Date(Date.now() + 3 * 86_400_000)
    const futureIso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`
    const dropCol = host.querySelector<HTMLElement>(`[data-timeline-day-iso="${futureIso}"]`)
    if (!cardEl || !dropCol) throw new Error('drag fixtures not found')
    const dt = mockDataTransfer()
    dispatchDrag(cardEl, 'dragstart', dt)
    dispatchDrag(dropCol, 'drop', dt)
    await tick()
    await tick()

    expect(horizonBodies).toHaveLength(1)
    expect(horizonBodies[0]).toMatchObject({
      fiberId: 'test/drag-to-timeline',
      horizon: 'soon',
      due: futureIso,
    })

    modal.unmount()
    host.remove()
  })

  it('dropping on a lifecycle column header still posts /kanban/transition', async () => {
    const response = emptyKanbanResponse()
    const card = makeKanbanCard({
      id: 'test/transition-card',
      name: 'Transition Card',
      shuttleKind: 'oneshot',
      shuttleAgent: 'pi-sonnet',
    })
    response.now.inFlight = [card]
    response.totals = { ...response.totals, inFlight: 1 }
    const transitionBodies: unknown[] = []
    const horizonBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/transition')) {
        transitionBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/kanban/horizon')) {
        horizonBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/kanban')) return Promise.resolve(jsonResponse(response))
      return Promise.resolve(jsonResponse({}))
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })

    modal.mount(host)
    await tick()

    const cardEl = host.querySelector<HTMLElement>('[data-fiber-id="test/transition-card"]')
    const awaitingHead = host.querySelector<HTMLElement>('.kbn-section-now .kbn-col-awaitingReview .kbn-col-head')
    if (!cardEl || !awaitingHead) throw new Error('transition fixtures not found')
    const dt = mockDataTransfer()
    dispatchDrag(cardEl, 'dragstart', dt)
    dispatchDrag(awaitingHead, 'drop', dt)
    await tick()
    await tick()

    expect(horizonBodies).toEqual([])
    expect(transitionBodies).toHaveLength(1)
    expect(transitionBodies[0]).toMatchObject({
      fiberId: 'test/transition-card',
      target: 'awaitingReview',
    })

    modal.unmount()
    host.remove()
  })

})

// ── Grid card previews ──────────────────────────────────────────────────────

describe('KanbanModal grid card outcome preview', () => {
  it('renders outcome markdown instead of showing raw markdown syntax', () => {
    const { el } = renderGridCard({
      outcome: 'Review **all three** papers.\n\n- Lisa\n- Paper four\n\nUse `loom`.',
    })

    const outcome = el.querySelector('.kbn-card-outcome')
    expect(outcome?.querySelector('strong')?.textContent).toBe('all three')
    expect(outcome?.querySelectorAll('li')).toHaveLength(2)
    expect(outcome?.querySelector('code')?.textContent).toBe('loom')
    expect(outcome?.textContent).not.toContain('**all three**')
  })

  it('keeps rendered links clickable without opening the detail modal', () => {
    const { el, detailOpen } = renderGridCard({
      outcome: 'Read [the notes](https://example.com/notes).',
    })

    const link = el.querySelector<HTMLAnchorElement>('.kbn-card-outcome a')
    expect(link?.href).toBe('https://example.com/notes')

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(detailOpen).not.toHaveBeenCalled()

    el.querySelector('.kbn-card-outcome')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(detailOpen).toHaveBeenCalledOnce()
  })
})

describe('KanbanModal grid card face', () => {
  it('renders agent glyph, actor label, due badge, and drift marker without tag chips', () => {
    const { el } = renderGridCard({
      shuttleKind: 'oneshot',
      shuttleAgent: 'pi-sonnet',
      due: '2026-05-15T00:00:00Z',
      tags: ['urgent', 'constitution'],
      storedHorizon: 'later',
      drifted: true,
    }, 'inFlight')

    expect(el.querySelector('.kbn-card-glyph')?.textContent).toBe('◐')
    expect(el.querySelector('.kbn-card-actor')?.textContent).toBe('pi-sonnet')
    expect(el.querySelector('.kbn-card-due')?.textContent).toContain('due')
    expect(el.querySelector('.kbn-card-drift')?.textContent).toBe('↑')
    expect(el.querySelector('.kbn-tag')).toBeNull()
    expect(el.textContent).not.toContain('urgent')
  })

  it('renders human due cards as me with the check glyph', () => {
    const { el } = renderGridCard({
      due: '2026-05-20T00:00:00Z',
      tags: ['task'],
    }, 'drafts')

    expect(el.querySelector('.kbn-card-glyph')?.textContent).toBe('✓')
    expect(el.querySelector('.kbn-card-actor')?.textContent).toBe('me')
    expect(el.querySelector('.kbn-card-due')?.textContent).toContain('due')
    expect(el.querySelector('.kbn-tag')).toBeNull()
  })
})

describe('KanbanModal grid card review actions', () => {
  it('sends the composted target when clicking an inline awaiting-review Compost button', async () => {
    const transitionBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/transition')) {
        transitionBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/kanban')) return Promise.resolve(jsonResponse(emptyKanbanResponse()))
      return Promise.resolve(jsonResponse({}))
    }))

    const { el, detailOpen } = renderGridCard({
      name: 'Constitution: Standing inbox triage — read + fiber creation',
      status: 'closed',
    }, 'awaitingReview')
    const compostBtn = Array.from(el.querySelectorAll<HTMLButtonElement>('.kbn-review-meta-btn'))
      .find((btn) => btn.textContent?.trim() === 'Compost')
    if (!compostBtn) throw new Error('Inline Compost button not found')

    compostBtn.click()
    await tick()

    expect(detailOpen).not.toHaveBeenCalled()
    expect(transitionBodies).toHaveLength(1)
    expect(transitionBodies[0]).toMatchObject({
      fiberId: 'test/my-constitution',
      target: 'composted',
    })
  })
})

// ── dispatchIneligibleReason unit tests ──────────────────────────────────────

describe('dispatchIneligibleReason', () => {
  it('maps not_eligible to a human readable message', () => {
    const msg = dispatchIneligibleReason('not_eligible')
    expect(msg).toContain('disabled')
    expect(msg).not.toBe('not_eligible')
  })

  it('maps not_due to a due-date message', () => {
    const msg = dispatchIneligibleReason('not_due')
    expect(msg).toContain('due')
  })

  it('maps disabled to an enable-shuttle message', () => {
    const msg = dispatchIneligibleReason('disabled')
    expect(msg).toContain('enabled')
  })

  it('maps closed to a reopen message', () => {
    const msg = dispatchIneligibleReason('closed')
    expect(msg).toContain('closed')
  })

  it('passes through unknown reason codes with a prefix', () => {
    const msg = dispatchIneligibleReason('some_future_code')
    expect(msg).toContain('some_future_code')
  })

  it('handles undefined gracefully', () => {
    const msg = dispatchIneligibleReason(undefined)
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })
})

// ── Contract tests: Dispatch Now button ──────────────────────────────────────

describe('FiberDetailModal dispatch — 200 success', () => {
  it('closes the modal and calls onSaved when daemon returns 200', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/v1/dispatch': () => jsonResponse({ dispatched: true, tmux_session: 'my-constitution-shuttle' }),
    }))

    const { dispatchBtn, onSaved } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    // Modal closed: overlay removed from DOM.
    expect(document.querySelector('.kbn-detail-overlay')).toBeNull()
    // Callback notified to refresh the kanban.
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('asks the daemon for ad-hoc immediate dispatch for standing roles', async () => {
    const dispatchBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/api/v1/dispatch')) {
        dispatchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'my-constitution-shuttle' }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { dispatchBtn } = await openDispatchModal(makeInFlightCard({ shuttleKind: 'standing' }))
    dispatchBtn.click()
    await tick()

    expect(dispatchBodies).toEqual([
      { fiber_id: 'test/my-constitution', ad_hoc: true },
    ])
  })

  it('does not mark one-shot immediate dispatch as ad-hoc', async () => {
    const dispatchBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/api/v1/dispatch')) {
        dispatchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'my-constitution-shuttle' }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { dispatchBtn } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    expect(dispatchBodies).toEqual([
      { fiber_id: 'test/my-constitution' },
    ])
  })

  it('dispatches city-scoped cards with their canonical Shuttle fiber id', async () => {
    const dispatchBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/api/v1/dispatch')) {
        dispatchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'work-shuttle' }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { dispatchBtn } = await openDispatchModal(makeInFlightCard({
      id: 'backend/work',
      projectSlug: 'backend/work',
      shuttleFiberId: 'ai-futures/portolan/backend/work',
    } as any))
    dispatchBtn.click()
    await tick()

    expect(dispatchBodies).toEqual([
      { fiber_id: 'ai-futures/portolan/backend/work' },
    ])
  })

  it('records a directive then ad-hoc dispatches standing roles immediately', async () => {
    const reviewBodies: unknown[] = []
    const dispatchBodies: unknown[] = []
    const transitionBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/review-comment')) {
        reviewBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/api/v1/dispatch')) {
        dispatchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'my-constitution-shuttle' }))
      }
      if (urlStr.includes('/kanban/transition')) {
        transitionBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { dispatchBtn, directiveTa, onSaved } = await openDispatchModal(makeInFlightCard({ shuttleKind: 'standing' }))
    directiveTa.value = 'Please continue this standing role now.'
    dispatchBtn.click()
    await tick()

    expect(reviewBodies).toEqual([
      {
        fiberId: 'test/my-constitution',
        directive: 'Please continue this standing role now.',
        resumeMode: 'fresh',
        interactive: false,
      },
    ])
    expect(dispatchBodies).toEqual([
      { fiber_id: 'test/my-constitution', ad_hoc: true },
    ])
    expect(transitionBodies).toEqual([])
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('tries scheduled standing resume via force/non-ad-hoc dispatch when a session id is recorded', async () => {
    const reviewBodies: unknown[] = []
    const dispatchBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/review-comment')) {
        reviewBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/api/v1/dispatch')) {
        dispatchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'my-constitution-shuttle' }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { resumeBtn, onSaved } = await openDispatchModal(makeInFlightCard({
      shuttleKind: 'standing',
      sessionId: 'stored-session-id',
    }))
    expect(resumeBtn.disabled).toBe(false)

    resumeBtn.click()
    await tick()

    expect(reviewBodies).toEqual([
      {
        fiberId: 'test/my-constitution',
        directive: '',
        resumeMode: 'previous',
        interactive: false,
      },
    ])
    expect(dispatchBodies).toEqual([
      { fiber_id: 'test/my-constitution', force: true },
    ])
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('disables previous-session resume when no session id is recorded', async () => {
    const reviewBodies: unknown[] = []
    const dispatchBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/review-comment')) {
        reviewBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/api/v1/dispatch')) {
        dispatchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ dispatched: true }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { resumeBtn } = await openDispatchModal(makeInFlightCard())

    expect(resumeBtn.disabled).toBe(true)
    expect(resumeBtn.title).toContain('No previous worker session')
    resumeBtn.click()
    await tick()

    expect(reviewBodies).toEqual([])
    expect(dispatchBodies).toEqual([])
  })

  it('oneshot resume reopens then dispatches immediately so Shuttle can surface resume errors', async () => {
    const reviewBodies: unknown[] = []
    const transitionBodies: unknown[] = []
    const dispatchBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/review-comment')) {
        reviewBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/kanban/transition')) {
        transitionBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/api/v1/dispatch')) {
        dispatchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ dispatched: false, reason: ':missing_session_id' }, 500))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { resumeBtn, errorEl, onSaved } = await openDispatchModal(makeInFlightCard({
      sessionId: 'stored-session-id',
    }))
    resumeBtn.click()
    await tick()

    expect(reviewBodies).toEqual([
      {
        fiberId: 'test/my-constitution',
        directive: '',
        resumeMode: 'previous',
        interactive: false,
      },
    ])
    expect(transitionBodies).toEqual([
      { fiberId: 'test/my-constitution', target: 'inFlight' },
      { fiberId: 'test/my-constitution', target: 'awaitingReview' },
    ])
    expect(dispatchBodies).toEqual([
      { fiber_id: 'test/my-constitution' },
    ])
    expect(errorEl.textContent).toContain('missing_session_id')
    expect(document.querySelector('.kbn-detail-overlay')).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('FiberDetailModal human-card promotion', () => {
  it('posts the selected agent to /kanban/promote-to-shuttle', async () => {
    const promoteBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/shuttle/agents')) {
        return Promise.resolve(jsonResponse({
          agents: [
            { id: 'pi-sonnet', default: true },
            { id: 'claude-sonnet' },
          ],
        }))
      }
      if (urlStr.includes('/kanban/promote-to-shuttle')) {
        promoteBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (urlStr.includes('/kanban/fiber-history')) {
        return Promise.resolve(jsonResponse({ events: [] }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { promoteBtn, agentSelect, onSaved } = await openPromoteModal()
    expect(promoteBtn.textContent).toContain('Promote')
    expect(agentSelect.value).toBe('pi-sonnet')

    promoteBtn.click()
    await tick()

    expect(promoteBodies).toHaveLength(1)
    expect(promoteBodies[0]).toMatchObject({
      fiberId: 'test/my-constitution',
      agent: 'pi-sonnet',
      card: { id: 'test/my-constitution' },
    })
    expect(document.querySelector('.kbn-detail-overlay')).toBeNull()
    expect(onSaved).toHaveBeenCalledOnce()
  })
})

describe('FiberDetailModal terminal transitions', () => {
  it('sends the composted target when clicking Compost', async () => {
    const transitionBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/transition')) {
        transitionBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { onSaved } = await openDispatchModal(makeInFlightCard())
    detailActionButton('Compost').click()
    await tick()

    expect(transitionBodies).toEqual([
      { fiberId: 'test/my-constitution', target: 'composted' },
    ])
    expect(document.querySelector('.kbn-detail-overlay')).toBeNull()
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('sends the tempered target when clicking Temper', async () => {
    const transitionBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/kanban/transition')) {
        transitionBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { onSaved } = await openDispatchModal(makeInFlightCard())
    detailActionButton('Temper').click()
    await tick()

    expect(transitionBodies).toEqual([
      { fiberId: 'test/my-constitution', target: 'tempered' },
    ])
    expect(document.querySelector('.kbn-detail-overlay')).toBeNull()
    expect(onSaved).toHaveBeenCalledOnce()
  })
})

describe('FiberDetailModal dispatch — 409 already running', () => {
  it('shows Already Running on button and an info message without closing', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/v1/dispatch': () => jsonResponse(
        { dispatched: false, reason: 'already_running' },
        409,
      ),
    }))

    const { dispatchBtn, errorEl, onSaved } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    expect(dispatchBtn.textContent).toContain('Already running')
    expect(dispatchBtn.disabled).toBe(true)
    expect(errorEl.style.display).not.toBe('none')
    expect(errorEl.textContent).toContain('running')
    // Modal stays open — user sees the state, doesn't get kicked to kanban.
    expect(document.querySelector('.kbn-detail-overlay')).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('FiberDetailModal dispatch — 422 not eligible', () => {
  it('shows a human-readable refusal (not the raw "not_eligible" atom) and re-enables button', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/v1/dispatch': () => jsonResponse(
        { dispatched: false, reason: 'not_eligible', fiber_id: 'test/my-constitution' },
        422,
      ),
    }))

    const { dispatchBtn, errorEl, onSaved } = await openDispatchModal(makeInFlightCard())
    const originalLabel = dispatchBtn.textContent

    dispatchBtn.click()
    await tick()

    // Error is shown and is not the raw atom string.
    expect(errorEl.style.display).not.toBe('none')
    expect(errorEl.textContent).not.toBe('not_eligible')
    expect(errorEl.textContent).not.toContain('Not eligible: not_eligible')
    // Button re-enabled for retry.
    expect(dispatchBtn.disabled).toBe(false)
    expect(dispatchBtn.textContent).toBe(originalLabel)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('shows specific message mentioning "due" for not_due reason', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/v1/dispatch': () => jsonResponse(
        { dispatched: false, reason: 'not_due' },
        422,
      ),
    }))

    const { dispatchBtn, errorEl } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    expect(errorEl.textContent).toContain('due')
  })
})

describe('FiberDetailModal dispatch — 500 daemon error', () => {
  it('surfaces the daemon error message in the error element', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/v1/dispatch': () => jsonResponse(
        { dispatched: false, reason: 'tmux session spawn failed: exit 1' },
        500,
      ),
    }))

    const { dispatchBtn, errorEl, onSaved } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    expect(errorEl.style.display).not.toBe('none')
    expect(errorEl.textContent).toContain('tmux session spawn failed')
    expect(dispatchBtn.disabled).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('falls back to a status-code message when body has no reason', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/v1/dispatch': () => new Response('', { status: 500 }),
    }))

    const { dispatchBtn, errorEl } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    expect(errorEl.style.display).not.toBe('none')
    expect(errorEl.textContent).toMatch(/500|fail/i)
  })
})

describe('FiberDetailModal dispatch — URL target (regression: Tauri IPv6 trap)', () => {
  // The Shuttle daemon binds 127.0.0.1:4000 (IPv4-only on BEAM). Tauri's
  // WKWebView resolves `localhost` IPv6-first and hits ECONNREFUSED on
  // `::1:4000`, reporting "Load failed" instead of falling back to IPv4.
  // The fix: the frontend must always target `127.0.0.1:4000` directly,
  // never deriving the hostname from apiBase. See
  // gotchas/ipv6-localhost-vs-ipv4-shuttle-daemon.
  it('dispatches to 127.0.0.1:4000, not derived from apiBase hostname', async () => {
    const capturedUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request) => {
      const urlStr = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      if (urlStr.includes('/api/v1/dispatch')) {
        capturedUrls.push(urlStr)
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'x-shuttle' }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { dispatchBtn } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    expect(capturedUrls).toHaveLength(1)
    // Hardcoded 127.0.0.1, not 'localhost' (apiBase host) — the whole point.
    expect(capturedUrls[0]).toBe('http://127.0.0.1:4000/api/v1/dispatch')
    expect(capturedUrls[0]).not.toContain('localhost')
  })
})

describe('FiberDetailModal dispatch — network / CORS failure', () => {
  it('shows "Couldn\'t reach daemon" instead of a generic browser error', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/v1/dispatch')) {
        return Promise.reject(new TypeError('Load failed'))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))

    const { dispatchBtn, errorEl, onSaved } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    expect(errorEl.style.display).not.toBe('none')
    // Message must explain the daemon is unreachable — not just "Load failed".
    const text = errorEl.textContent ?? ''
    expect(text).toMatch(/couldn't reach|daemon|unreachable/i)
    expect(dispatchBtn.disabled).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('includes the daemon URL in the error so the user knows where it tried', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/v1/dispatch')) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))

    const { dispatchBtn, errorEl } = await openDispatchModal(makeInFlightCard())
    dispatchBtn.click()
    await tick()

    // The error message should reference the daemon address (port 4000).
    expect(errorEl.textContent).toContain('4000')
  })
})

// ── Feature 1: card sizing ────────────────────────────────────────────────────
// Cards are sized to their natural content. flex-grow is intentionally off so
// a single short-outcome card doesn't stretch to full viewport height; long
// outcomes are line-clamped on .kbn-card-outcome itself, so the card never
// exceeds "header + name + slug + N-line outcome + meta."

describe('Feature 1: cards sized to natural content', () => {
  it('KanbanModal.css sets flex-grow:0 on .kbn-card', async () => {
    // Static contract test: the .kbn-card rule must set flex-grow:0 so cards
    // don't balloon in partial columns. Empty space at the column bottom is
    // less ugly than a stretched card with a short outcome.
    const fs = await import('fs')
    const path = await import('path')
    const cssPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'KanbanModal.css',
    )
    const css = fs.readFileSync(cssPath, 'utf8')

    // Match within the .kbn-card { … } block specifically.
    const match = css.match(/\.kbn-card\s*\{[^}]*flex-grow\s*:\s*0[^}]*\}/)
    expect(match, '.kbn-card must declare flex-grow:0').not.toBeNull()
  })

  it('KanbanModal.css line-clamps the outcome via --card-line-clamp (default 4)', async () => {
    // The outcome carries the truncation: -webkit-line-clamp via a CSS
    // custom property whose default is 4. JS bumps the variable per column
    // when there's spare vertical space (see expandOutcomesToFillSpace).
    const fs = await import('fs')
    const path = await import('path')
    const cssPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'KanbanModal.css',
    )
    const css = fs.readFileSync(cssPath, 'utf8')

    expect(css).toMatch(/-webkit-line-clamp\s*:\s*var\(--card-line-clamp,\s*4\)/)
  })

  it('renderCard produces a .kbn-card element (flex-grow is inherited via CSS)', () => {
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })
    const card = makeKanbanCard()
    const el = (modal as unknown as {
      renderCard: (card: ReturnType<typeof makeKanbanCard>, kind: 'inFlight') => HTMLElement
    }).renderCard(card, 'inFlight')

    expect(el.classList.contains('kbn-card')).toBe(true)
    expect(el.classList.contains('kbn-card-inFlight')).toBe(true)
  })

  it('columns with a single card use .kbn-col-list flex container', () => {
    // Verifies the layout structure that makes flex-grow meaningful:
    // .kbn-col-list is a flex column; .kbn-card children with flex-grow:1
    // distribute any spare space equally.
    const modal = new KanbanModal({
      apiBase: 'http://localhost:4004',
      onOpenFiber: vi.fn(),
    })
    const col = (modal as unknown as {
      renderColumn: (
        kind: 'inFlight',
        cards: ReturnType<typeof makeKanbanCard>[],
        staleness: Record<string, never>,
      ) => HTMLElement
    }).renderColumn('inFlight', [makeKanbanCard()], {})

    const list = col.querySelector('.kbn-col-list')
    expect(list).not.toBeNull()
    const card = list?.querySelector('.kbn-card')
    expect(card).not.toBeNull()
  })

  it('.kbn-empty placeholder has flex-grow:0 so it does not balloon in empty columns', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const cssPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'KanbanModal.css',
    )
    const css = fs.readFileSync(cssPath, 'utf8')
    // .kbn-empty must explicitly opt out of growing so an empty column's
    // placeholder doesn't stretch to full height.
    expect(css).toMatch(/\.kbn-empty[^}]*flex-grow\s*:\s*0/)
  })
})

describe('Feature 2: narrow detail modal layout', () => {
  it('stacks chrome above the outcome when the detail dialog is narrow', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const cssPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'KanbanModal.css',
    )
    const css = fs.readFileSync(cssPath, 'utf8')

    expect(css).toMatch(/\.kbn-detail-dialog\s*\{[^}]*container-name\s*:\s*kbn-detail[^}]*container-type\s*:\s*inline-size/)
    expect(css).toMatch(/@container\s+kbn-detail\s+\(max-width:\s*1120px\)\s*\{[\s\S]*\.kbn-detail-body\s*\{[^}]*flex-direction\s*:\s*column/)
    expect(css).toMatch(/@container\s+kbn-detail\s+\(max-width:\s*1120px\)\s*\{[\s\S]*\.kbn-detail-col-right\s*\{[^}]*order\s*:\s*1/)
    expect(css).toMatch(/@container\s+kbn-detail\s+\(max-width:\s*1120px\)\s*\{[\s\S]*\.kbn-detail-col-left\s*\{[^}]*order\s*:\s*2/)
  })
})

describe('FiberDetailModal vellum open options', () => {
  it('marks command-click on the vellum button as a new-window open', async () => {
    vi.stubGlobal('fetch', mockFetch({}))
    const onOpenFiber = vi.fn()
    const modal = new FiberDetailModal('http://localhost:4004', onOpenFiber, vi.fn())
    modal.open(makeKanbanCard(), undefined, 'drafts')
    await tick()

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.kbn-detail-vellum-btn'))
      .find((candidate) => candidate.textContent?.includes('Open in vellum'))
    if (!button) throw new Error('Open in vellum button not found')

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))

    expect(onOpenFiber).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test/my-constitution' }),
      { openInNewWindow: true },
    )
    modal.close()
  })
})

// ── Feature 3: parent-fiber reactive dropdown ─────────────────────────────────
// The parent-fiber section in the card modal must:
//   a) open its dropdown immediately on focus (not only when the input is empty)
//   b) pass the current input value as the initial search query
//   c) include cityId and excludeId in every search request
//   d) update the pending-parent display on option selection
//   e) support keyboard navigation: ArrowDown (input→first option),
//      ArrowDown/Up (within options), Escape (close + return focus)

describe('Feature 3: parent-fiber reactive dropdown', () => {
  /** Open a detail modal for a nested fiber and return handy DOM refs. */
  async function openParentModal(
    cardOverrides: Record<string, unknown> = {},
    scopeCityId?: string,
  ) {
    const modal = new FiberDetailModal('http://localhost:4004', vi.fn(), vi.fn())
    modal.open(makeKanbanCard({ id: 'test/my-fiber', ...cardOverrides }), scopeCityId)
    await tick()
    const overlay = document.querySelector<HTMLElement>('.kbn-detail-overlay')!
    const parentInput = overlay.querySelector<HTMLInputElement>('.kbn-detail-parent-input')!
    const parentDropdown = overlay.querySelector<HTMLElement>('.kbn-detail-parent-dropdown')!
    const currentParentEl = overlay.querySelector<HTMLElement>('.kbn-detail-current-parent')!
    return { modal, overlay, parentInput, parentDropdown, currentParentEl }
  }

  it('dropdown is hidden before any interaction', async () => {
    vi.stubGlobal('fetch', mockFetch({}))
    const { parentDropdown } = await openParentModal()
    expect(parentDropdown.style.display).toBe('none')
  })

  it('dropdown opens immediately on focus — reactive (no empty-input guard)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [
          { id: 'test', name: 'test root', depth: 1 },
          { id: 'test/sibling', name: 'Sibling', depth: 2 },
        ],
      }),
    }))
    const { parentInput, parentDropdown } = await openParentModal()

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    expect(parentDropdown.style.display).not.toBe('none')
    expect(parentDropdown.querySelectorAll('button')).toHaveLength(2)
  })

  it('opens dropdown even when input already has a value (old guard removed)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [{ id: 'test/other', name: 'Other Fiber', depth: 2 }],
      }),
    }))
    const { parentInput, parentDropdown } = await openParentModal()

    // Pre-fill with a previously-selected parent name.
    parentInput.value = 'Some Previously Selected Parent'
    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    expect(parentDropdown.style.display).not.toBe('none')
    expect(parentDropdown.querySelectorAll('button')).toHaveLength(1)
  })

  it('passes the current input value as the search query on focus', async () => {
    const searchUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('fiber-search')) searchUrls.push(url)
      return Promise.resolve(jsonResponse({ fibers: [] }))
    }))
    const { parentInput } = await openParentModal()

    parentInput.value = 'partial query'
    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    expect(searchUrls.length).toBeGreaterThan(0)
    expect(searchUrls[0]).toContain('q=partial+query')
  })

  it('includes excludeId in every fiber-search request', async () => {
    const searchUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('fiber-search')) searchUrls.push(url)
      return Promise.resolve(jsonResponse({ fibers: [] }))
    }))
    const { parentInput } = await openParentModal({ id: 'test/my-fiber' })

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    expect(searchUrls.length).toBeGreaterThan(0)
    expect(searchUrls[0]).toContain('excludeId=test%2Fmy-fiber')
  })

  it('threads cityId into the search URL when the kanban is city-scoped', async () => {
    const searchUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('fiber-search')) searchUrls.push(url)
      return Promise.resolve(jsonResponse({ fibers: [] }))
    }))
    const { parentInput } = await openParentModal({}, 'city-xyz')

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    expect(searchUrls.length).toBeGreaterThan(0)
    expect(searchUrls[0]).toContain('cityId=city-xyz')
  })

  it('does NOT include cityId when the kanban is in global scope', async () => {
    const searchUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('fiber-search')) searchUrls.push(url)
      return Promise.resolve(jsonResponse({ fibers: [] }))
    }))
    const { parentInput } = await openParentModal({}, undefined)

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    expect(searchUrls.length).toBeGreaterThan(0)
    expect(searchUrls[0]).not.toContain('cityId')
  })

  it('clicking an option updates pending parent display and closes dropdown', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [{ id: 'test/new-parent', name: 'New Parent', depth: 2 }],
      }),
    }))
    const { parentInput, parentDropdown, currentParentEl } = await openParentModal()

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    const opt = parentDropdown.querySelector<HTMLButtonElement>('button')!
    opt.click()

    expect(currentParentEl.textContent).toContain('test/new-parent')
    expect(currentParentEl.textContent).toContain('pending')
    expect(parentInput.value).toBe('New Parent')
    expect(parentDropdown.style.display).toBe('none')
  })

  it('Escape on the input closes the dropdown', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [{ id: 'test/x', name: 'X', depth: 2 }],
      }),
    }))
    const { parentInput, parentDropdown } = await openParentModal()

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()
    expect(parentDropdown.style.display).not.toBe('none')

    parentInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(parentDropdown.style.display).toBe('none')
  })

  it('ArrowDown on the input focuses the first dropdown option', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [{ id: 'test/a', name: 'A', depth: 2 }],
      }),
    }))
    const { parentInput, parentDropdown } = await openParentModal()

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    parentInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )

    const firstOpt = parentDropdown.querySelector<HTMLElement>('button')!
    expect(document.activeElement).toBe(firstOpt)
  })

  it('ArrowDown and ArrowUp navigate between dropdown options', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [
          { id: 'test/a', name: 'A', depth: 2 },
          { id: 'test/b', name: 'B', depth: 2 },
          { id: 'test/c', name: 'C', depth: 2 },
        ],
      }),
    }))
    const { parentInput, parentDropdown } = await openParentModal()

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()

    // Move into dropdown
    parentInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )
    const [optA, optB, optC] = parentDropdown.querySelectorAll<HTMLElement>('button')
    expect(document.activeElement).toBe(optA)

    // Down to B
    optA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(optB)

    // Down to C
    optB.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(optC)

    // ArrowDown at last item stays at last item
    optC.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(optC)

    // Up back to B
    optC.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(optB)
  })

  it('ArrowUp on the first dropdown option returns focus to the input', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [{ id: 'test/a', name: 'A', depth: 2 }],
      }),
    }))
    const { parentInput, parentDropdown } = await openParentModal()

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()
    parentInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )

    const firstOpt = parentDropdown.querySelector<HTMLElement>('button')!
    firstOpt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))

    expect(document.activeElement).toBe(parentInput)
  })

  it('Escape in the dropdown closes it and returns focus to the input', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [{ id: 'test/a', name: 'A', depth: 2 }],
      }),
    }))
    const { parentInput, parentDropdown } = await openParentModal()

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()
    parentInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )

    const firstOpt = parentDropdown.querySelector<HTMLElement>('button')!
    firstOpt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(parentDropdown.style.display).toBe('none')
    expect(document.activeElement).toBe(parentInput)
  })

  it('aria-expanded reflects dropdown visibility', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'fiber-search': () => jsonResponse({
        fibers: [{ id: 'test/a', name: 'A', depth: 2 }],
      }),
    }))
    const { parentInput } = await openParentModal()
    expect(parentInput.getAttribute('aria-expanded')).toBe('false')

    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()
    expect(parentInput.getAttribute('aria-expanded')).toBe('true')

    parentInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(parentInput.getAttribute('aria-expanded')).toBe('false')
  })

  it('selected parent id is sent to /kanban/fiber-patch on save', async () => {
    const patchBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('fiber-search'))
        return Promise.resolve(jsonResponse({ fibers: [{ id: 'test/new-p', name: 'New P', depth: 2 }] }))
      if (url.includes('fiber-patch')) {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { parentInput, parentDropdown } = await openParentModal()

    // Pick a parent via the dropdown
    parentInput.dispatchEvent(new FocusEvent('focus'))
    await tick()
    parentDropdown.querySelector<HTMLButtonElement>('button')!.click()

    // Click Save
    const saveBtn = document.querySelector<HTMLButtonElement>('.kbn-detail-save-btn')!
    saveBtn.click()
    await tick()

    expect(patchBodies).toHaveLength(1)
    expect((patchBodies[0] as Record<string, unknown>).parentId).toBe('test/new-p')
  })
})
