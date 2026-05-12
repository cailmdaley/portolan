import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPageAttention,
  MIN_UNFOCUSED_POLL_INTERVAL_MS,
  nextVisiblePollIntervalMs,
  shouldRunVisiblePoll,
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
