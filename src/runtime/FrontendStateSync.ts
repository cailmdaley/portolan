import type { Activity, City, Session, ServerCity, ServerOrigin, ServerSession } from '../state/types'
import { normalizeCity, normalizeSession } from '../state/types'

const API_BASE = `ws://${window.location.hostname}:4004`

const MAX_ACTIVITIES_PER_SESSION = 10
const ACTIVITY_RATE_WINDOW_MS = 60_000

export function getActivitySessionKey(originId: string, tmuxSession: string): string {
  return `${originId}:${tmuxSession}`
}

interface ServerState {
  cities: ServerCity[]
  sessions: ServerSession[]
  origins?: ServerOrigin[]
  activities?: Record<string, Activity[]>
}

interface ConfirmUnpinMessage {
  type: 'confirmUnpin'
  cityId: string
  cityName: string
  sessionCount: number
}

interface CityPinnedMessage {
  type: 'cityPinned'
  city: ServerCity
}

interface CityUnpinnedMessage {
  type: 'cityUnpinned'
  cityId: string
}

interface CityMovedMessage {
  type: 'cityMoved'
  cityId: string
  newPosition: { q: number; r: number }
}

interface ErrorMessage {
  type: 'error'
  message: string
}

interface ActivityMessage {
  type: 'activity'
  activity: {
    tmuxSession: string
    tool: string
    summary?: string
    fullPath?: string
    timestamp: number
    originId?: string
    activitySessionKey?: string
  }
}

type ServerMessage =
  | ServerState
  | ConfirmUnpinMessage
  | CityPinnedMessage
  | CityUnpinnedMessage
  | CityMovedMessage
  | ErrorMessage
  | ActivityMessage

interface FrontendStateSnapshot {
  cities: City[]
  sessions: Session[]
  origins: ServerOrigin[]
  activityBySessionKey: ReadonlyMap<string, Activity[]>
  isInitialState: boolean
  urlCityId: string | null
}

interface FrontendActivityUpdate {
  activitySessionKey: string
  activities: Activity[]
}

interface FrontendStateSyncOptions {
  handlePanelMessage: (message: unknown) => boolean
  onSocketOpen: (ws: WebSocket) => void
  onStateChange: (snapshot: FrontendStateSnapshot) => void
  onActivity: (update: FrontendActivityUpdate) => void
  onServerError: (message: string) => void
}

export class FrontendStateSync {
  private options: FrontendStateSyncOptions
  private cities: City[] = []
  private sessions: Session[] = []
  private origins: ServerOrigin[] = []
  private ws: WebSocket | null = null
  private wsCleanedUp = false
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private hasReceivedInitialState = false
  private activityBySessionKey = new Map<string, Activity[]>()
  private recentActivityEventTimestamps: number[] = []
  private totalActivityEventsReceived = 0

  constructor(options: FrontendStateSyncOptions) {
    this.options = options
  }

  connect(): void {
    if (this.wsCleanedUp) return
    this.ws = new WebSocket(API_BASE)

    this.ws.onopen = () => {
      console.log('Connected to portolan server')
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = null
      }
      this.options.onSocketOpen(this.ws!)
    }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        this.handleMessage(message)
      } catch (error) {
        console.error('Failed to parse message:', error)
      }
    }

    this.ws.onclose = () => {
      if (this.wsCleanedUp) return
      console.log('Disconnected from server, reconnecting...')
      if (this.reconnectTimeout) return
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null
        this.connect()
      }, 2000)
    }

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
  }

  dispose(): void {
    this.wsCleanedUp = true
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.ws?.close()
    this.ws = null
  }

  send(message: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(message))
    return true
  }

  getWebSocketState(): 'missing' | 'connecting' | 'open' | 'closing' | 'closed' {
    if (!this.ws) return 'missing'
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting'
      case WebSocket.OPEN:
        return 'open'
      case WebSocket.CLOSING:
        return 'closing'
      default:
        return 'closed'
    }
  }

  hasPendingReconnect(): boolean {
    return this.reconnectTimeout !== null
  }

  getHasReceivedInitialState(): boolean {
    return this.hasReceivedInitialState
  }

  getActivityStats(): {
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

  private handleMessage(message: ServerMessage): void {
    if (this.options.handlePanelMessage(message)) return

    if ('type' in message) {
      if (message.type === 'confirmUnpin') {
        const confirmed = window.confirm(
          `City "${message.cityName}" has ${message.sessionCount} active session(s).\n\n` +
          'The city will remain visible while sessions are active.\n' +
          'Remove persistence anyway?'
        )
        if (confirmed) {
          this.send({ type: 'confirmUnpinCity', cityId: message.cityId })
        }
        return
      }

      if (message.type === 'cityPinned' || message.type === 'cityUnpinned' || message.type === 'cityMoved') {
        return
      }

      if (message.type === 'error') {
        this.options.onServerError(message.message)
        return
      }

      if (message.type === 'activity') {
        this.handleActivityEvent(message.activity)
        return
      }
    }

    this.handleStateUpdate(message as ServerState)
  }

  private handleStateUpdate(state: ServerState): void {
    if (!state.cities || !state.sessions) return

    this.cities = state.cities.map(normalizeCity)
    this.sessions = state.sessions.map(normalizeSession)
    if (state.origins) {
      this.origins = state.origins
    }

    if (state.activities) {
      for (const [activitySessionKey, activities] of Object.entries(state.activities)) {
        this.activityBySessionKey.set(activitySessionKey, activities)
      }
    }

    const currentActivitySessionKeys = new Set(
      this.sessions.map(session => getActivitySessionKey(session.originId, session.tmuxSession))
    )
    for (const activitySessionKey of this.activityBySessionKey.keys()) {
      if (!currentActivitySessionKeys.has(activitySessionKey)) {
        this.activityBySessionKey.delete(activitySessionKey)
      }
    }

    const isInitialState = !this.hasReceivedInitialState && this.cities.length > 0
    if (isInitialState) {
      this.hasReceivedInitialState = true
    }

    this.options.onStateChange({
      cities: this.cities,
      sessions: this.sessions,
      origins: this.origins,
      activityBySessionKey: this.activityBySessionKey,
      isInitialState,
      urlCityId: isInitialState ? new URLSearchParams(window.location.search).get('city') : null,
    })
  }

  private handleActivityEvent(activity: ActivityMessage['activity']): void {
    const activitySessionKey = activity.activitySessionKey
      ?? (activity.originId ? getActivitySessionKey(activity.originId, activity.tmuxSession) : null)
    if (!activitySessionKey) return

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

    this.options.onActivity({
      activitySessionKey,
      activities,
    })
  }

  private pruneRecentActivityEvents(now = Date.now()): void {
    const cutoff = now - ACTIVITY_RATE_WINDOW_MS
    while (this.recentActivityEventTimestamps.length > 0 && this.recentActivityEventTimestamps[0] < cutoff) {
      this.recentActivityEventTimestamps.shift()
    }
  }
}
