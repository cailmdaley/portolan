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
    tags: ['constitution'],
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
    ...overrides,
  }
}

function renderGridCard(overrides: Record<string, unknown> = {}): {
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
    renderCard: (card: ReturnType<typeof makeKanbanCard>, kind: 'drafts') => HTMLElement
  }).renderCard(makeKanbanCard(overrides), 'drafts')
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
    columns: {
      ideas: [],
      drafts: [],
      inFlight: [],
      awaitingReview: [],
      tempered: [],
      composted: [],
    },
    totals: {
      ideas: 0,
      drafts: 0,
      inFlight: 0,
      awaitingReview: 0,
      tempered: 0,
      composted: 0,
    },
    temperedTotal: 0,
    staleness: { local: { status: 'fresh' } },
  }
}

/** Wait one microtask tick for async handlers to settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Clean DOM between tests.
  document.body.innerHTML = ''
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
      '/api/v1/dispatch': () => jsonResponse({ dispatched: true, tmux_session: 'shuttle-test/my-constitution' }),
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
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'shuttle-test/my-constitution' }))
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
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'shuttle-test/my-constitution' }))
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
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'shuttle-test/my-constitution' }))
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

  it('tries scheduled standing resume via force/non-ad-hoc dispatch without prechecking a session id', async () => {
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
        return Promise.resolve(jsonResponse({ dispatched: true, tmux_session: 'shuttle-test/my-constitution' }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    const { resumeBtn, onSaved } = await openDispatchModal(makeInFlightCard({
      shuttleKind: 'standing',
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
