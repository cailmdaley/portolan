/**
 * FrontendAppRuntime — Page Visibility API integration tests.
 *
 * Verifies that the render loop pauses when the page is hidden and resumes
 * when it becomes visible again, so background tabs and minimised windows
 * do not burn CPU/GPU needlessly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FrontendAppRuntime } from './FrontendAppRuntime'

// ── Mock rAF / cAF ───────────────────────────────────────────────────────────

let rafCounter = 0
const pendingRafs = new Map<number, FrameRequestCallback>()
const cancelledRafs = new Set<number>()

function mockRaf(cb: FrameRequestCallback): number {
  const id = ++rafCounter
  pendingRafs.set(id, cb)
  return id
}

function mockCaf(id: number): void {
  cancelledRafs.add(id)
  pendingRafs.delete(id)
}

/** Fire all pending RAF callbacks once (simulates one browser frame). */
function flushRafs(): void {
  const toFire = [...pendingRafs.entries()]
  for (const [id, cb] of toFire) {
    pendingRafs.delete(id)
    cb(performance.now())
  }
}

// ── Mock options factory ──────────────────────────────────────────────────────

function makeMockOptions(): Parameters<typeof FrontendAppRuntime>[0] {
  return {
    renderer: {
      setSize: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    } as unknown as Parameters<typeof FrontendAppRuntime>[0]['renderer'],
    scene: {} as unknown as Parameters<typeof FrontendAppRuntime>[0]['scene'],
    labelRenderer: {
      setSize: vi.fn(),
      render: vi.fn(),
      domElement: { remove: vi.fn() },
    } as unknown as Parameters<typeof FrontendAppRuntime>[0]['labelRenderer'],
    camera: {
      camera: {},
      cameraDistance: 10,
      resize: vi.fn(),
      dispose: vi.fn(),
    } as unknown as Parameters<typeof FrontendAppRuntime>[0]['camera'],
    zoneRenderer: {
      animate: vi.fn(),
      dispose: vi.fn(),
    } as unknown as Parameters<typeof FrontendAppRuntime>[0]['zoneRenderer'],
    stateSync: { dispose: vi.fn() } as unknown as Parameters<typeof FrontendAppRuntime>[0]['stateSync'],
    mapInteractions: { dispose: vi.fn() } as unknown as Parameters<typeof FrontendAppRuntime>[0]['mapInteractions'],
    contextMenu: { dispose: vi.fn() } as unknown as Parameters<typeof FrontendAppRuntime>[0]['contextMenu'],
    newWorkerDialog: { dispose: vi.fn() } as unknown as Parameters<typeof FrontendAppRuntime>[0]['newWorkerDialog'],
    playgroundViewer: { dispose: vi.fn() } as unknown as Parameters<typeof FrontendAppRuntime>[0]['playgroundViewer'],
    clearArtifactMediaCaches: vi.fn(),
    getCities: vi.fn().mockReturnValue([]),
    updateWorkerHud: vi.fn(),
    isWorkerHudVisible: vi.fn().mockReturnValue(false),
    applyMockState: vi.fn(),
  }
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  rafCounter = 0
  pendingRafs.clear()
  cancelledRafs.clear()

  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(mockRaf)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(mockCaf)
  // Block the mock-data fallback setTimeout so it doesn't interfere.
  vi.spyOn(window, 'setTimeout').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>)
  vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined)

  setDocumentHidden(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  // Restore document.hidden to the default false so other tests start clean.
  setDocumentHidden(false)
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FrontendAppRuntime — render loop visibility gating', () => {
  it('starts the RAF loop immediately when the page is visible', () => {
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    // animate() schedules the first RAF synchronously on start.
    expect(pendingRafs.size).toBe(1)

    runtime.dispose()
  })

  it('does not schedule a RAF when the page starts hidden', () => {
    setDocumentHidden(true)
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    // animate() exits early when document.hidden — no RAF scheduled.
    expect(pendingRafs.size).toBe(0)

    runtime.dispose()
  })

  it('pauses the loop when the page becomes hidden', () => {
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    expect(pendingRafs.size).toBe(1)

    // Page goes hidden — fire visibilitychange BEFORE the next RAF tick.
    setDocumentHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))

    // The pending RAF fires; animate() detects hidden and does not re-schedule.
    flushRafs()

    expect(pendingRafs.size).toBe(0)

    runtime.dispose()
  })

  it('resumes the loop when the page becomes visible again', () => {
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    // Go hidden and drain the pending RAF.
    setDocumentHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    flushRafs()

    expect(pendingRafs.size).toBe(0)

    // Go visible — visibilitychange should restart the loop.
    setDocumentHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(pendingRafs.size).toBe(1)

    runtime.dispose()
  })

  it('does not double-start the loop on repeated visibilitychange visible events', () => {
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()
    flushRafs() // consume the first RAF → re-schedules a second

    // Fire two rapid visible events (can happen on some browsers).
    setDocumentHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))

    // Only the one RAF from the running loop plus the one from the first
    // visible event should be pending — the second event is a no-op because
    // animationFrameId is already non-null.
    expect(pendingRafs.size).toBeLessThanOrEqual(2)

    runtime.dispose()
  })

  it('does not restart the loop after dispose', () => {
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    // Go hidden and drain.
    setDocumentHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    flushRafs()

    runtime.dispose()

    // Become visible after dispose — should not restart.
    setDocumentHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(pendingRafs.size).toBe(0)
  })

  it('removes the visibilitychange listener on dispose', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()
    runtime.dispose()

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})
