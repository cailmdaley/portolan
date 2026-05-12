export type PageAttentionState = 'hidden' | 'visible-unfocused' | 'active'

export const UNFOCUSED_VISIBLE_FRAME_MS = 100
export const MIN_UNFOCUSED_POLL_INTERVAL_MS = 60_000

export function getPageAttention(): PageAttentionState {
  if (document.hidden) return 'hidden'
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
    return 'visible-unfocused'
  }
  return 'active'
}

export function isPageVisible(): boolean {
  return getPageAttention() !== 'hidden'
}

export function nextVisiblePollIntervalMs(activeIntervalMs: number): number {
  return Math.max(activeIntervalMs * 2, MIN_UNFOCUSED_POLL_INTERVAL_MS)
}

export function shouldRunVisiblePoll(
  lastRunAtMs: number | null,
  nowMs: number,
  activeIntervalMs: number,
): boolean {
  const attention = getPageAttention()
  if (attention === 'hidden') return false
  if (lastRunAtMs === null) return true
  const interval = attention === 'active'
    ? activeIntervalMs
    : nextVisiblePollIntervalMs(activeIntervalMs)
  return nowMs - lastRunAtMs >= interval
}
