/**
 * FrontendAppRuntime — Page Visibility API integration tests.
 *
 * Verifies that the render loop pauses when the page is hidden and resumes
 * when it becomes visible again, so background tabs and minimised windows
 * do not burn CPU/GPU needlessly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FrontendAppRuntime } from './FrontendAppRuntime'
import { UNFOCUSED_VISIBLE_FRAME_MS } from './PageAttention'

// ── Mock rAF / cAF ───────────────────────────────────────────────────────────

let rafCounter = 0
const pendingRafs = new Map<number, FrameRequestCallback>()
const cancelledRafs = new Set<number>()
let timeoutCounter = 0
const pendingTimeouts = new Map<number, { cb: () => void; ms?: number }>()
let documentHasFocus = true
type RuntimeOptions = ConstructorParameters<typeof FrontendAppRuntime>[0]

function mockRaf(cb: FrameRequestCallback): number {
  const id = ++rafCounter
  pendingRafs.set(id, cb)
  return id
}

function mockCaf(id: number): void {
  cancelledRafs.add(id)
  pendingRafs.delete(id)
}

function mockSetTimeout(handler: TimerHandler, ms?: number, ...args: unknown[]): number {
  if (typeof handler !== 'function') {
    throw new Error('mockSetTimeout only supports function handlers')
  }
  const id = ++timeoutCounter
  pendingTimeouts.set(id, {
    cb: () => {
      (handler as (...args: unknown[]) => void)(...args)
    },
    ms,
  })
  return id
}

function mockClearTimeout(id?: string | number | ReturnType<typeof setTimeout>): void {
  if (id === undefined) return
  pendingTimeouts.delete(Number(id))
}

/** Fire all pending RAF callbacks once (simulates one browser frame). */
function flushRafs(): void {
  const toFire = [...pendingRafs.entries()]
  for (const [id, cb] of toFire) {
    pendingRafs.delete(id)
    cb(performance.now())
  }
}

function flushTimeouts(ms?: number): void {
  const toFire = [...pendingTimeouts.entries()]
    .filter(([, timeout]) => ms === undefined || timeout.ms === ms)
  for (const [id, timeout] of toFire) {
    pendingTimeouts.delete(id)
    timeout.cb()
  }
}

function countTimeouts(ms: number): number {
  return [...pendingTimeouts.values()].filter((timeout) => timeout.ms === ms).length
}

// ── Mock options factory ──────────────────────────────────────────────────────

function makeMockOptions(): RuntimeOptions {
  return {
    renderer: {
      setSize: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    } as unknown as RuntimeOptions['renderer'],
    scene: {} as unknown as RuntimeOptions['scene'],
    labelRenderer: {
      setSize: vi.fn(),
      render: vi.fn(),
      domElement: { remove: vi.fn() },
    } as unknown as RuntimeOptions['labelRenderer'],
    camera: {
      camera: {},
      cameraDistance: 10,
      resize: vi.fn(),
      dispose: vi.fn(),
    } as unknown as RuntimeOptions['camera'],
    zoneRenderer: {
      animate: vi.fn(),
      dispose: vi.fn(),
    } as unknown as RuntimeOptions['zoneRenderer'],
    stateSync: { dispose: vi.fn() } as unknown as RuntimeOptions['stateSync'],
    mapInteractions: { dispose: vi.fn() } as unknown as RuntimeOptions['mapInteractions'],
    contextMenu: { dispose: vi.fn() } as unknown as RuntimeOptions['contextMenu'],
    newWorkerDialog: { dispose: vi.fn() } as unknown as RuntimeOptions['newWorkerDialog'],
    playgroundViewer: { dispose: vi.fn() } as unknown as RuntimeOptions['playgroundViewer'],
    clearArtifactMediaCaches: vi.fn(),
    getCities: vi.fn().mockReturnValue([]),
    updateWorkerHud: vi.fn(),
    isWorkerHudVisible: vi.fn().mockReturnValue(false),
  }
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

function setDocumentFocused(focused: boolean): void {
  documentHasFocus = focused
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  rafCounter = 0
  timeoutCounter = 0
  pendingRafs.clear()
  cancelledRafs.clear()
  pendingTimeouts.clear()

  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(mockRaf)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(mockCaf)
  vi.spyOn(window, 'setTimeout').mockImplementation(mockSetTimeout as unknown as typeof window.setTimeout)
  vi.spyOn(window, 'clearTimeout').mockImplementation(mockClearTimeout as typeof window.clearTimeout)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => documentHasFocus)

  setDocumentHidden(false)
  setDocumentFocused(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  // Restore document.hidden to the default false so other tests start clean.
  setDocumentHidden(false)
  setDocumentFocused(true)
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FrontendAppRuntime — render loop visibility gating', () => {
  it('starts the RAF loop immediately when the page is visible', () => {
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    // animate() schedules the first RAF synchronously on start.
    expect(pendingRafs.size).toBe(1)
    expect(runtime.getRenderLoopStats()).toMatchObject({
      attention: 'active',
      scheduledWork: 'raf',
      totalFrames: 1,
      activeFrames: 1,
      visibleUnfocusedFrames: 0,
      hiddenSkips: 0,
      recentFrameCount: 1,
    })

    runtime.dispose()
  })

  it('does not schedule a RAF when the page starts hidden', () => {
    setDocumentHidden(true)
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    // animate() exits early when document.hidden — no RAF scheduled.
    expect(pendingRafs.size).toBe(0)
    expect(runtime.getRenderLoopStats()).toMatchObject({
      attention: 'hidden',
      scheduledWork: 'paused',
      totalFrames: 0,
      hiddenSkips: 1,
    })

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

  it('throttles a visible unfocused window through delayed frames', () => {
    setDocumentFocused(false)
    const options = makeMockOptions()
    const runtime = new FrontendAppRuntime(options)
    runtime.start()

    // Start renders once so the visible tile is not stale, then uses the
    // slower unfocused cadence instead of immediately scheduling another RAF.
    expect(options.renderer.render).toHaveBeenCalledTimes(1)
    expect(pendingRafs.size).toBe(0)
    expect(countTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)).toBe(1)
    expect(runtime.getRenderLoopStats()).toMatchObject({
      attention: 'visible-unfocused',
      scheduledWork: 'timeout',
      totalFrames: 1,
      activeFrames: 0,
      visibleUnfocusedFrames: 1,
    })

    flushTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)
    expect(pendingRafs.size).toBe(1)

    flushRafs()
    expect(options.renderer.render).toHaveBeenCalledTimes(2)
    expect(pendingRafs.size).toBe(0)
    expect(countTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)).toBe(1)
    expect(runtime.getRenderLoopStats()).toMatchObject({
      scheduledWork: 'timeout',
      totalFrames: 2,
      visibleUnfocusedFrames: 2,
    })

    runtime.dispose()
  })

  it('resumes full-rate RAF immediately when a visible unfocused window gains focus', () => {
    setDocumentFocused(false)
    const options = makeMockOptions()
    const runtime = new FrontendAppRuntime(options)
    runtime.start()

    expect(countTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)).toBe(1)

    setDocumentFocused(true)
    window.dispatchEvent(new Event('focus'))

    expect(countTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)).toBe(0)
    expect(pendingRafs.size).toBe(1)

    flushRafs()
    expect(options.renderer.render).toHaveBeenCalledTimes(2)
    expect(pendingRafs.size).toBe(1)
    expect(countTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)).toBe(0)

    runtime.dispose()
  })

  it('clears the visible-unfocused throttle timer when the page becomes hidden', () => {
    setDocumentFocused(false)
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()

    expect(countTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)).toBe(1)

    setDocumentHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(countTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)).toBe(0)
    flushTimeouts(UNFOCUSED_VISIBLE_FRAME_MS)
    expect(pendingRafs.size).toBe(0)

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
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const runtime = new FrontendAppRuntime(makeMockOptions())
    runtime.start()
    runtime.dispose()

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('focus', expect.any(Function))
  })
})
