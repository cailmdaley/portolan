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
import { getPageAttention, type PageAttentionState } from './PageAttention'
import { readUrlState, type UrlState } from './UrlFragment'

const API_BASE = `ws://${window.location.hostname}:4004`

function applyCollectionDelta<T extends { id: string }>(
  items: T[],
  delta: CollectionDelta<T> | undefined,
): T[] {
  if (!delta) return items
  const removed = new Set(delta.remove)
  const byId = new Map(items.filter(item => !removed.has(item.id)).map(item => [item.id, item]))
  for (const item of delta.upsert) {
    byId.set(item.id, item)
  }
  return Array.from(byId.values())
}

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

interface CollectionDelta<T extends { id: string }> {
  upsert: T[]
  remove: string[]
}

interface StateDeltaMessage {
  type: 'stateDelta'
  cities?: CollectionDelta<ServerCity>
  sessions?: CollectionDelta<ServerSession>
  origins?: ServerOrigin[]
  activities?: Record<string, Activity[]>
  meetingBridge?: ServerMeetingBridgeState | null
}

interface BrowserAttentionMessage {
  type: 'browserAttention'
  attention: PageAttentionState
}

type ServerMessage =
  | ServerState
  | ConfirmUnpinMessage
  | CityPinnedMessage
  | CityUnpinnedMessage
  | CityMovedMessage
  | ErrorMessage
  | ActivityMessage
  | StateDeltaMessage

interface FrontendStateSnapshot {
  cities: City[]
  sessions: Session[]
  origins: ServerOrigin[]
  activityBySessionKey: ReadonlyMap<string, Activity[]>
  meetingBridge: ServerMeetingBridgeState | null
  isInitialState: boolean
  /** Initial-load URL fragment state — full Stage J shape (mode, fiber,
   *  file, scope, city). Null on non-initial state pushes. The host uses
   *  this to drive the cold-load deep-link restore in main.ts. */
  urlState: UrlState | null
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
  private serverCities: ServerCity[] = []
  private serverSessions: ServerSession[] = []
  private cities: City[] = []
  private sessions: Session[] = []
  private origins: ServerOrigin[] = []
  private meetingBridge: ServerMeetingBridgeState | null = null
  private ws: WebSocket | null = null
  private wsCleanedUp = false
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private hasReceivedInitialState = false
  private activityStore = new FrontendActivityStore()
  private attentionListenersInstalled = false

  constructor(options: FrontendStateSyncOptions) {
    this.options = options
  }

  connect(): void {
    if (this.wsCleanedUp) return
    this.installAttentionListeners()
    this.ws = new WebSocket(API_BASE)

    this.ws.onopen = () => {
      console.log('Connected to portolan server')
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = null
      }
      this.options.onSocketOpen(this.ws!)
      this.publishBrowserAttention()
    }

    this.ws.onmessage = (event) => {
      // Split parse from handle so a downstream ReferenceError /
      // TypeError (e.g. an HMR-stale module reaching for a removed
      // private helper) doesn't masquerade as a JSON-parse failure.
      // Both are still caught — losing one ws message is recoverable;
      // tearing down the socket is not — but the labels distinguish the
      // two and the underlying error is logged so future investigations
      // don't chase phantom server payloads. See
      // vellum-dogfood/findopenvellummodal-not-defined.
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        console.error('Failed to parse server message:', error, event.data)
        return
      }
      try {
        this.handleMessage(message as ServerMessage)
      } catch (error) {
        console.error('Failed to handle server message:', error, message)
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
    this.removeAttentionListeners()
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

      if (message.type === 'stateDelta') {
        this.handleStateDelta(message)
        return
      }
    }

    this.handleStateUpdate(message as ServerState)
  }

  private handleStateUpdate(state: ServerState): void {
    if (!state.cities || !state.sessions) return

    this.serverCities = state.cities
    this.serverSessions = state.sessions
    this.cities = this.serverCities.map(normalizeCity)
    this.sessions = this.serverSessions.map(normalizeSession)
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
      urlState: isInitialState ? readUrlState() : null,
    })
  }

  private handleStateDelta(delta: StateDeltaMessage): void {
    this.handleStateUpdate({
      cities: applyCollectionDelta(this.serverCities, delta.cities),
      sessions: applyCollectionDelta(this.serverSessions, delta.sessions),
      origins: delta.origins ?? this.origins,
      activities: delta.activities,
      meetingBridge: Object.prototype.hasOwnProperty.call(delta, 'meetingBridge')
        ? delta.meetingBridge ?? null
        : this.meetingBridge,
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

  private installAttentionListeners(): void {
    if (this.attentionListenersInstalled) return
    this.attentionListenersInstalled = true
    document.addEventListener('visibilitychange', this.publishBrowserAttention)
    window.addEventListener('focus', this.publishBrowserAttention)
    window.addEventListener('blur', this.publishBrowserAttention)
  }

  private removeAttentionListeners(): void {
    if (!this.attentionListenersInstalled) return
    this.attentionListenersInstalled = false
    document.removeEventListener('visibilitychange', this.publishBrowserAttention)
    window.removeEventListener('focus', this.publishBrowserAttention)
    window.removeEventListener('blur', this.publishBrowserAttention)
  }

  private readonly publishBrowserAttention = (): void => {
    const message: BrowserAttentionMessage = {
      type: 'browserAttention',
      attention: getPageAttention(),
    }
    this.send(message)
  }
}
