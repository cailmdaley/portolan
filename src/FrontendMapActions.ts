import type { City, HexCoord } from './state/types'
import type { NewWorkerDialog } from './ui/NewWorkerDialog'

interface FrontendMapActionsOptions {
  newWorkerDialog: NewWorkerDialog
  sendMessage: (message: unknown) => boolean
  getWebSocketState: () => 'missing' | 'connecting' | 'open' | 'closing' | 'closed'
}

export interface RemoteCityActivationOptions {
  agentRuntime?: 'node' | 'rust'
  once?: boolean
}

export class FrontendMapActions {
  private newWorkerDialog: NewWorkerDialog
  private sendMessage: (message: unknown) => boolean
  private getWebSocketState: () => 'missing' | 'connecting' | 'open' | 'closing' | 'closed'

  constructor(options: FrontendMapActionsOptions) {
    this.newWorkerDialog = options.newWorkerDialog
    this.sendMessage = options.sendMessage
    this.getWebSocketState = options.getWebSocketState
  }

  async promptNewWorker(city: City): Promise<void> {
    const result = await this.newWorkerDialog.show(city.name)
    if (!result) return

    this.sendMessage({
      type: 'newWorker',
      cityPath: city.path,
      name: result.name || undefined,
      cli: result.cli || undefined,
      chrome: result.chrome || undefined,
      continue: result.continue || undefined,
    })
  }

  promptAddCity(hex: HexCoord): void {
    const path = window.prompt(
      'Path for the new city.\nLocal: /abs/path\nRemote: host:/abs/path  (e.g. candide:/automnt/…)'
    )
    if (!path) return

    if (!this.sendMessage({
      type: 'pinCity',
      path: path.trim(),
      position: { q: hex.q, r: hex.r },
    })) {
      console.error('WebSocket not ready, state:', this.getWebSocketState())
    }
  }

  unpinCity(cityId: string): void {
    this.sendMessage({
      type: 'unpinCity',
      cityId,
    })
  }

  moveCity(cityId: string, hex: HexCoord): void {
    this.sendMessage({
      type: 'moveCity',
      cityId,
      newPosition: { q: hex.q, r: hex.r },
    })
  }

  killWorker(sessionId: string): void {
    this.sendMessage({
      type: 'killWorker',
      sessionId,
    })
  }

  focusKittyTab(sessionId: string): void {
    this.sendMessage({ type: 'focus', sessionId })
  }

  async activateRemoteCity(city: City, options: RemoteCityActivationOptions = {}): Promise<void> {
    try {
      const response = await fetch('http://localhost:4004/activate-city', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cityId: city.id,
          ...(options.agentRuntime ? { agentRuntime: options.agentRuntime } : {}),
          origin: city.originId.replace(/^remote-/, ''),
          once: options.once === true,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        console.error(`[Activate] Failed: ${result.error}`)
        alert(`Failed to activate remote city: ${result.error}`)
        return
      }
      // Stage I — pre-Stage-I we summoned the CityHUD on success
      // (`this.showCity(city)`); without the HUD there's no overlay to
      // bring up. The hex click that triggered activation already moved
      // the camera + set `lastFocusedCityId`, and the now-active city
      // re-arrives via the next `onStateChange` snapshot, so the user's
      // next `v` / `k` / `/` lands on the activated city correctly.
      void city
    } catch (err) {
      console.error('[Activate] Network error:', err)
      alert('Failed to connect to server')
    }
  }
}
