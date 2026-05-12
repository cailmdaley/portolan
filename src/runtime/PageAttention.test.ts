import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPageAttention,
  MIN_UNFOCUSED_POLL_INTERVAL_MS,
  nextVisiblePollIntervalMs,
  shouldRunVisiblePoll,
  VisiblePollScheduler,
} from './PageAttention'

let documentHasFocus = true

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

function setDocumentFocused(focused: boolean): void {
  documentHasFocus = focused
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockImplementation(() => documentHasFocus)
  setDocumentHidden(false)
  setDocumentFocused(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  setDocumentHidden(false)
  setDocumentFocused(true)
})

describe('PageAttention', () => {
  it('classifies hidden pages before focus state', () => {
    setDocumentHidden(true)
    setDocumentFocused(true)

    expect(getPageAttention()).toBe('hidden')
    expect(shouldRunVisiblePoll(null, 10_000, 1_000)).toBe(false)
  })

  it('classifies visible focused pages as active', () => {
    expect(getPageAttention()).toBe('active')
    expect(shouldRunVisiblePoll(1_000, 1_999, 1_000)).toBe(false)
    expect(shouldRunVisiblePoll(1_000, 2_000, 1_000)).toBe(true)
  })

  it('uses a slower cadence for visible but unfocused pages', () => {
    setDocumentFocused(false)

    expect(getPageAttention()).toBe('visible-unfocused')
    expect(nextVisiblePollIntervalMs(15_000)).toBe(MIN_UNFOCUSED_POLL_INTERVAL_MS)
    expect(shouldRunVisiblePoll(0, MIN_UNFOCUSED_POLL_INTERVAL_MS - 1, 15_000)).toBe(false)
    expect(shouldRunVisiblePoll(0, MIN_UNFOCUSED_POLL_INTERVAL_MS, 15_000)).toBe(true)
  })
})

describe('VisiblePollScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs immediately for an active page and then uses the active interval', async () => {
    const poll = vi.fn()
    const scheduler = new VisiblePollScheduler({ intervalMs: 5_000, poll })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(poll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(poll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(2)

    scheduler.stop()
  })

  it('does not keep a timer alive while hidden and refreshes when visible again', async () => {
    const poll = vi.fn()
    const scheduler = new VisiblePollScheduler({ intervalMs: 5_000, poll })

    setDocumentHidden(true)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(poll).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    setDocumentHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)

    expect(poll).toHaveBeenCalledTimes(1)

    scheduler.stop()
  })

  it('uses the slow visible-unfocused cadence and reschedules on focus', async () => {
    const poll = vi.fn()
    const scheduler = new VisiblePollScheduler({ intervalMs: 5_000, poll })

    setDocumentFocused(false)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MIN_UNFOCUSED_POLL_INTERVAL_MS - 1)
    expect(poll).toHaveBeenCalledTimes(1)

    setDocumentFocused(true)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(poll).toHaveBeenCalledTimes(3)

    scheduler.stop()
  })
})
