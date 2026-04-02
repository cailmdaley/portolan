import type {
  Activity,
  City,
  ServerCity,
  ServerMeetingBridgeState,
  ServerOrigin,
  ServerSession,
  Session,
} from '../state/types'
import { normalizeCity, normalizeSession } from '../state/types'
import { FrontendActivityStore, type FrontendActivityEvent } from './FrontendActivityStore'

const API_BASE = `ws://${window.location.hostname}:4004`

interface ServerState {
  cities: ServerCity[]
  sessions: ServerSession[]
  origins?: ServerOrigin[]
  activities?: Record<string, Activity[]>
  meetingBridge?: ServerMeetingBridgeState | null
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
  activity: FrontendActivityEvent
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
  meetingBridge: ServerMeetingBridgeState | null
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
  private meetingBridge: ServerMeetingBridgeState | null = null
  private ws: WebSocket | null = null
  private wsCleanedUp = false
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private hasReceivedInitialState = false
  private activityStore = new FrontendActivityStore()

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
    return this.activityStore.getStats()
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
    this.meetingBridge = state.meetingBridge ?? null

    this.activityStore.syncSessionActivities(state.activities, this.sessions)

    const isInitialState = !this.hasReceivedInitialState && this.cities.length > 0
    if (isInitialState) {
      this.hasReceivedInitialState = true
    }

    this.options.onStateChange({
      cities: this.cities,
      sessions: this.sessions,
      origins: this.origins,
      activityBySessionKey: this.activityStore.getActivities(),
      meetingBridge: this.meetingBridge,
      isInitialState,
      urlCityId: isInitialState ? new URLSearchParams(window.location.search).get('city') : null,
    })
  }

  private handleActivityEvent(activity: ActivityMessage['activity']): void {
    const update = this.activityStore.applyActivityEvent(activity)
    if (!update) return

    this.options.onActivity({
      activitySessionKey: update.activitySessionKey,
      activities: update.activities,
    })
  }
}
