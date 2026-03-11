import type { City, GitStatus, Session } from '../state/types'
import { escapeHtml } from './utils'
import type { NewWorkerDialog } from './NewWorkerDialog'

interface CityHUDHeaderOptions {
  headerWidget: HTMLElement
  getCurrentCity: () => City | null
  getWebSocket: () => WebSocket | null
  getNewWorkerDialog: () => NewWorkerDialog | null
  getOnViewClaims: () => ((city: City) => void) | null
  getOnViewPlaygrounds: () => ((city: City) => void) | null
  getOnFocusWorker: () => ((sessionId: string) => void) | null
}

export class CityHUDHeader {
  private headerWidget: HTMLElement
  private getCurrentCity: () => City | null
  private getWebSocket: () => WebSocket | null
  private getNewWorkerDialog: () => NewWorkerDialog | null
  private getOnViewClaims: () => ((city: City) => void) | null
  private getOnViewPlaygrounds: () => ((city: City) => void) | null
  private getOnFocusWorker: () => ((sessionId: string) => void) | null
  private cityWorkers: Session[] = []

  constructor(options: CityHUDHeaderOptions) {
    this.headerWidget = options.headerWidget
    this.getCurrentCity = options.getCurrentCity
    this.getWebSocket = options.getWebSocket
    this.getNewWorkerDialog = options.getNewWorkerDialog
    this.getOnViewClaims = options.getOnViewClaims
    this.getOnViewPlaygrounds = options.getOnViewPlaygrounds
    this.getOnFocusWorker = options.getOnFocusWorker
  }

  reset(): void {
    this.cityWorkers = []
    this.headerWidget.querySelector('.hud-git-detail-content')!.innerHTML = ''
    this.headerWidget.querySelector('.hud-actions')!.innerHTML = ''
    this.headerWidget.querySelector('.hud-header-workers')!.innerHTML = ''
  }

  show(city: City): void {
    this.renderGitDetail(city.gitStatus)
    this.renderActions(city)
    this.renderWorkers()
  }

  updateWorkers(sessions: Session[]): void {
    const currentCity = this.getCurrentCity()
    this.cityWorkers = currentCity
      ? sessions.filter(session => session.cityId === currentCity.id)
      : []
    this.renderWorkers()
  }

  getRuntimeStats(): { cityWorkerCount: number } {
    return { cityWorkerCount: this.cityWorkers.length }
  }

  private renderGitDetail(status?: GitStatus): void {
    const content = this.headerWidget.querySelector('.hud-git-detail-content')!
    if (!status?.isRepo) {
      content.innerHTML = ''
      return
    }

    const rows: string[] = []
    rows.push(`<div class="hud-gd-row">
      <span class="hud-gd-label">branch</span>
      <span class="hud-gd-value hud-gd-branch">${escapeHtml(status.branch)}</span>
    </div>`)

    if (status.ahead > 0 || status.behind > 0) {
      const parts: string[] = []
      if (status.ahead > 0) parts.push(`<span class="hud-gd-ahead">↑${status.ahead}</span>`)
      if (status.behind > 0) parts.push(`<span class="hud-gd-behind">↓${status.behind}</span>`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">remote</span>
        <span class="hud-gd-value">${parts.join(' ')}</span>
      </div>`)
    }

    const staged = status.staged
    if (staged.added + staged.modified + staged.deleted > 0) {
      const parts: string[] = []
      if (staged.added > 0) parts.push(`+${staged.added}`)
      if (staged.modified > 0) parts.push(`~${staged.modified}`)
      if (staged.deleted > 0) parts.push(`-${staged.deleted}`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">staged</span>
        <span class="hud-gd-value hud-gd-staged">${parts.join(' ')}</span>
      </div>`)
    }

    const unstaged = status.unstaged
    if (unstaged.added + unstaged.modified + unstaged.deleted > 0) {
      const parts: string[] = []
      if (unstaged.added > 0) parts.push(`+${unstaged.added}`)
      if (unstaged.modified > 0) parts.push(`~${unstaged.modified}`)
      if (unstaged.deleted > 0) parts.push(`-${unstaged.deleted}`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">unstaged</span>
        <span class="hud-gd-value hud-gd-unstaged">${parts.join(' ')}</span>
      </div>`)
    }

    if (status.untracked > 0) {
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">untracked</span>
        <span class="hud-gd-value hud-gd-untracked">${status.untracked} file${status.untracked !== 1 ? 's' : ''}</span>
      </div>`)
    }

    if (status.linesAdded > 0 || status.linesRemoved > 0) {
      const parts: string[] = []
      if (status.linesAdded > 0) parts.push(`<span class="hud-git-add">+${status.linesAdded}</span>`)
      if (status.linesRemoved > 0) parts.push(`<span class="hud-git-rm">−${status.linesRemoved}</span>`)
      rows.push(`<div class="hud-gd-row">
        <span class="hud-gd-label">diff</span>
        <span class="hud-gd-value">${parts.join(' ')}</span>
      </div>`)
    }

    if (status.lastCommitMessage) {
      const timeStr = status.lastCommitTime ? this.relativeTime(status.lastCommitTime) : ''
      const msg = status.lastCommitMessage.length > 48
        ? status.lastCommitMessage.slice(0, 48) + '…'
        : status.lastCommitMessage
      rows.push(`<div class="hud-gd-commit">
        <span class="hud-gd-commit-msg">${escapeHtml(msg)}</span>
        ${timeStr ? `<span class="hud-gd-commit-time">${timeStr}</span>` : ''}
      </div>`)
    }

    content.innerHTML = rows.join('')
  }

  private relativeTime(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  private renderActions(city: City): void {
    const buttons: string[] = []
    if (city.hasClaims) {
      buttons.push('<button class="hud-action-btn hud-action-claims" title="Claims">⚖</button>')
    }
    if (city.hasPlaygrounds) {
      buttons.push('<button class="hud-action-btn hud-action-playgrounds" title="Playgrounds">▶</button>')
    }

    const row = this.headerWidget.querySelector('.hud-actions')!
    row.innerHTML = buttons.join('')

    row.querySelector('.hud-action-claims')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const currentCity = this.getCurrentCity()
      if (currentCity) this.getOnViewClaims()?.(currentCity)
    })

    row.querySelector('.hud-action-playgrounds')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const currentCity = this.getCurrentCity()
      if (currentCity) this.getOnViewPlaygrounds()?.(currentCity)
    })
  }

  private renderWorkers(): void {
    const container = this.headerWidget.querySelector('.hud-header-workers')!
    const parts: string[] = ['<span class="hud-header-workers-label">workers</span>']

    const chips = this.cityWorkers.map(session => {
      const statusClass = session.status === 'working' ? 'working' : 'idle'
      return `<span class="hud-worker-chip ${statusClass}" data-session-id="${session.id}" title="${escapeHtml(session.name)}">` +
        `<span class="hud-worker-dot ${statusClass}">●</span>${escapeHtml(session.name)}</span>`
    })

    chips.push('<button class="hud-worker-add" title="New Worker">+</button>')
    container.innerHTML = parts.concat(chips).join('')

    for (const chip of container.querySelectorAll<HTMLElement>('.hud-worker-chip')) {
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        const sessionId = chip.dataset.sessionId
        if (sessionId) this.getOnFocusWorker()?.(sessionId)
      })
    }

    container.querySelector('.hud-worker-add')?.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.showNewWorkerDialog()
    })
  }

  private async showNewWorkerDialog(): Promise<void> {
    const currentCity = this.getCurrentCity()
    const dialog = this.getNewWorkerDialog()
    if (!currentCity || !dialog) return

    const result = await dialog.show(currentCity.name)
    if (!result) return

    const ws = this.getWebSocket()
    if (ws?.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({
      type: 'newWorker',
      cityPath: currentCity.path,
      name: result.name || undefined,
      cli: result.cli || undefined,
      chrome: result.chrome || undefined,
      continue: result.continue || undefined,
    }))
  }
}
