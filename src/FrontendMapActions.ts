import type { City, HexCoord } from './state/types'
import type { NewWorkerDialog } from './ui/NewWorkerDialog'

interface FrontendMapActionsOptions {
  newWorkerDialog: NewWorkerDialog
  sendMessage: (message: unknown) => boolean
  getWebSocketState: () => 'missing' | 'connecting' | 'open' | 'closing' | 'closed'
  showCity: (city: City) => void
}

export class FrontendMapActions {
  private newWorkerDialog: NewWorkerDialog
  private sendMessage: (message: unknown) => boolean
  private getWebSocketState: () => 'missing' | 'connecting' | 'open' | 'closing' | 'closed'
  private showCity: (city: City) => void

  constructor(options: FrontendMapActionsOptions) {
    this.newWorkerDialog = options.newWorkerDialog
    this.sendMessage = options.sendMessage
    this.getWebSocketState = options.getWebSocketState
    this.showCity = options.showCity
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

  async activateRemoteCity(city: City): Promise<void> {
    try {
      const response = await fetch(`http://localhost:4004/activate-city?cityId=${city.id}`, {
        method: 'POST',
      })

      const result = await response.json()

      if (response.ok) {
        this.showCity(city)
      } else {
        console.error(`[Activate] Failed: ${result.error}`)
        alert(`Failed to activate remote city: ${result.error}`)
      }
    } catch (err) {
      console.error('[Activate] Network error:', err)
      alert('Failed to connect to server')
    }
  }
}
