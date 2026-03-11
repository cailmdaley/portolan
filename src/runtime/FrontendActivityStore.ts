import type { Activity, Session } from '../state/types'

const MAX_ACTIVITIES_PER_SESSION = 10
const ACTIVITY_RATE_WINDOW_MS = 60_000

export function getActivitySessionKey(originId: string, tmuxSession: string): string {
  return `${originId}:${tmuxSession}`
}

export interface FrontendActivityEvent {
  tmuxSession: string
  tool: string
  summary?: string
  fullPath?: string
  timestamp: number
  originId?: string
  activitySessionKey?: string
}

export class FrontendActivityStore {
  private activityBySessionKey = new Map<string, Activity[]>()
  private recentActivityEventTimestamps: number[] = []
  private totalActivityEventsReceived = 0

  getActivities(): ReadonlyMap<string, Activity[]> {
    return this.activityBySessionKey
  }

  syncSessionActivities(
    sessionActivities: Record<string, Activity[]> | undefined,
    sessions: Session[],
  ): void {
    if (sessionActivities) {
      for (const [activitySessionKey, activities] of Object.entries(sessionActivities)) {
        this.activityBySessionKey.set(activitySessionKey, activities)
      }
    }

    const currentActivitySessionKeys = new Set(
      sessions.map(session => getActivitySessionKey(session.originId, session.tmuxSession))
    )
    for (const activitySessionKey of this.activityBySessionKey.keys()) {
      if (!currentActivitySessionKeys.has(activitySessionKey)) {
        this.activityBySessionKey.delete(activitySessionKey)
      }
    }
  }

  applyActivityEvent(activity: FrontendActivityEvent): { activitySessionKey: string; activities: Activity[] } | null {
    const activitySessionKey = activity.activitySessionKey
      ?? (activity.originId ? getActivitySessionKey(activity.originId, activity.tmuxSession) : null)
    if (!activitySessionKey) return null

    this.totalActivityEventsReceived += 1
    this.recentActivityEventTimestamps.push(Date.now())
    this.pruneRecentActivityEvents()

    let activities = this.activityBySessionKey.get(activitySessionKey)
    if (!activities) {
      activities = []
      this.activityBySessionKey.set(activitySessionKey, activities)
    }

    activities.unshift({
      tool: activity.tool,
      summary: activity.summary,
      fullPath: activity.fullPath,
      timestamp: activity.timestamp,
    })
    if (activities.length > MAX_ACTIVITIES_PER_SESSION) {
      activities.pop()
    }

    return { activitySessionKey, activities }
  }

  getStats(): {
    stats: {
      streamCount: number
      bufferedEventCount: number
      maxBufferedEventsPerStream: number
      streamWithMostEvents: string | null
    }
    maxPerStreamLimit: number
    totalEventsReceived: number
    recentEventsPerMinute: number
  } {
    this.pruneRecentActivityEvents()

    let bufferedEventCount = 0
    let maxBufferedEventsPerStream = 0
    let streamWithMostEvents: string | null = null

    for (const [activitySessionKey, activities] of this.activityBySessionKey.entries()) {
      bufferedEventCount += activities.length
      if (activities.length > maxBufferedEventsPerStream) {
        maxBufferedEventsPerStream = activities.length
        streamWithMostEvents = activitySessionKey
      }
    }

    return {
      stats: {
        streamCount: this.activityBySessionKey.size,
        bufferedEventCount,
        maxBufferedEventsPerStream,
        streamWithMostEvents,
      },
      maxPerStreamLimit: MAX_ACTIVITIES_PER_SESSION,
      totalEventsReceived: this.totalActivityEventsReceived,
      recentEventsPerMinute: this.recentActivityEventTimestamps.length,
    }
  }

  private pruneRecentActivityEvents(now = Date.now()): void {
    const cutoff = now - ACTIVITY_RATE_WINDOW_MS
    while (this.recentActivityEventTimestamps.length > 0 && this.recentActivityEventTimestamps[0] < cutoff) {
      this.recentActivityEventTimestamps.shift()
    }
  }
}
