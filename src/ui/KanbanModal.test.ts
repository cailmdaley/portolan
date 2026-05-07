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

  const directiveTa = document.querySelector('.kbn-detail-directive') as HTMLTextAreaElement | null
  if (!directiveTa) throw new Error('Directive textarea not found')

  // The error element follows the actions section — same actionsErr shared by
  // all action buttons. We pick the first kbn-detail-error in the actions section.
  const errors = document.querySelectorAll('.kbn-detail-error')
  // actionsErr is the first one created (before tagsErr), so index 0.
  const errorEl = errors[0] as HTMLElement
  if (!errorEl) throw new Error('Error element not found')

  return { modal, dispatchBtn, directiveTa, errorEl, onSaved }
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

  it('asks the daemon to force immediate dispatch for standing roles', async () => {
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
      { fiber_id: 'test/my-constitution', force: true },
    ])
  })

  it('does not force immediate dispatch for one-shot fibers', async () => {
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

  it('records a directive then force-dispatches standing roles immediately', async () => {
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
      },
    ])
    expect(dispatchBodies).toEqual([
      { fiber_id: 'test/my-constitution', force: true },
    ])
    expect(transitionBodies).toEqual([])
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
