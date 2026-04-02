import type { City, GitStatus, Session } from '../state/types'
import { escapeHtml } from './utils'
import type { NewWorkerDialog } from './NewWorkerDialog'
import type { MeetingBridgeState, MeetingRunState } from './hud-types'

const PORTOLAN_HTTP_BASE = `${window.location.protocol === 'https:' ? 'https' : 'http'}://${window.location.hostname}:4004`

interface CityHUDHeaderOptions {
  headerWidget: HTMLElement
  getCurrentCity: () => City | null
  getWebSocket: () => WebSocket | null
  getNewWorkerDialog: () => NewWorkerDialog | null
  getOnViewClaims: () => ((city: City) => void) | null
  getOnViewPlaygrounds: () => ((city: City) => void) | null
  getOnOpenFile: () => ((fullPath: string, originId: string, cityPath: string, cityId: string, line?: number) => void) | null
  getOnFocusWorker: () => ((sessionId: string) => void) | null
}

export class CityHUDHeader {
  private headerWidget: HTMLElement
  private getCurrentCity: () => City | null
  private getWebSocket: () => WebSocket | null
  private getNewWorkerDialog: () => NewWorkerDialog | null
  private getOnViewClaims: () => ((city: City) => void) | null
  private getOnViewPlaygrounds: () => ((city: City) => void) | null
  private getOnOpenFile: () => ((fullPath: string, originId: string, cityPath: string, cityId: string, line?: number) => void) | null
  private getOnFocusWorker: () => ((sessionId: string) => void) | null
  private cityWorkers: Session[] = []
  private meetingState: MeetingBridgeState | null = null
  private meetingPollHandle: ReturnType<typeof setInterval> | null = null
  private meetingActionInFlight = false

  constructor(options: CityHUDHeaderOptions) {
    this.headerWidget = options.headerWidget
    this.getCurrentCity = options.getCurrentCity
    this.getWebSocket = options.getWebSocket
    this.getNewWorkerDialog = options.getNewWorkerDialog
    this.getOnViewClaims = options.getOnViewClaims
    this.getOnViewPlaygrounds = options.getOnViewPlaygrounds
    this.getOnOpenFile = options.getOnOpenFile
    this.getOnFocusWorker = options.getOnFocusWorker
  }

  reset(): void {
    this.stopMeetingPolling()
    this.cityWorkers = []
    this.meetingState = null
    this.meetingActionInFlight = false
    this.headerWidget.querySelector('.hud-git-detail-content')!.innerHTML = ''
    this.headerWidget.querySelector('.hud-actions')!.innerHTML = ''
    this.headerWidget.querySelector('.hud-header-workers')!.innerHTML = ''
    this.headerWidget.querySelector('.hud-header-meeting')!.innerHTML = ''
  }

  show(city: City): void {
    this.renderGitDetail(city.gitStatus)
    this.renderActions(city)
    this.renderWorkers()
    this.renderMeeting()
    this.startMeetingPolling()
    void this.refreshMeetingState()
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

  private renderMeeting(): void {
    const container = this.headerWidget.querySelector('.hud-header-meeting')!
    const currentCity = this.getCurrentCity()
    if (!currentCity) {
      container.innerHTML = ''
      return
    }

    const activeMeeting = this.meetingState?.activeMeeting ?? null
    const cityMeeting = this.selectMeetingForCurrentCity()
    const meetingElsewhere = activeMeeting && !this.belongsToCurrentCity(activeMeeting)
    const buttonsDisabled = this.meetingActionInFlight ? 'disabled' : ''

    const lines: string[] = ['<div class="hud-meeting-header"><span class="hud-header-workers-label">meeting</span></div>']

    if (cityMeeting) {
      const workerName = this.lookupWorkerName(cityMeeting.sessionId, cityMeeting.tmuxSession)
      const statusClass = cityMeeting.status === 'error' ? 'error' : cityMeeting.status === 'running' ? 'running' : 'stopped'
      const timingLabel = cityMeeting.status === 'running'
        ? `since ${this.relativeTime(cityMeeting.startedAt)}`
        : cityMeeting.stoppedAt
          ? `stopped ${this.relativeTime(cityMeeting.stoppedAt)}`
          : `started ${this.relativeTime(cityMeeting.startedAt)}`

      lines.push(`
        <div class="hud-meeting-card">
          <div class="hud-meeting-row">
            <span class="hud-meeting-status ${statusClass}">${escapeHtml(cityMeeting.status)}</span>
            <span class="hud-meeting-worker">${escapeHtml(workerName)}</span>
            <span class="hud-meeting-time">${escapeHtml(timingLabel)}</span>
          </div>
          <div class="hud-meeting-meta">
            <span>${cityMeeting.chunkCount} chunk${cityMeeting.chunkCount === 1 ? '' : 's'}</span>
            <span>${cityMeeting.injectedCount} sent</span>
            <span>${escapeHtml(cityMeeting.sourceType)}</span>
          </div>
          ${cityMeeting.lastChunkPreview ? `<div class="hud-meeting-preview">${escapeHtml(cityMeeting.lastChunkPreview)}</div>` : ''}
          ${cityMeeting.lastError ? `<div class="hud-meeting-error">${escapeHtml(cityMeeting.lastError)}</div>` : ''}
          <div class="hud-meeting-actions">
            ${cityMeeting.status === 'running'
              ? `<button class="hud-meeting-btn hud-meeting-stop" ${buttonsDisabled}>Stop</button>`
              : this.renderMeetingStartButtons(buttonsDisabled)}
          </div>
          <div class="hud-meeting-actions hud-meeting-links">
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.transcriptPath)}">Transcript log</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.injectionsPath)}">Worker injections</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.metadataPath)}">Meeting metadata</button>
          </div>
        </div>
      `)
    } else if (this.cityWorkers.length > 0) {
      lines.push(`
        <div class="hud-meeting-card">
          <div class="hud-meeting-meta">
            <span>${meetingElsewhere ? 'another meeting is active elsewhere; starting here will replace it' : 'inject VoiceInk transcript chunks into a worker session'}</span>
          </div>
          <div class="hud-meeting-actions">
            ${this.renderMeetingStartButtons(buttonsDisabled)}
          </div>
        </div>
      `)
    } else {
      lines.push('<div class="hud-meeting-empty">Start or choose a worker first.</div>')
    }

    container.innerHTML = lines.join('')

    for (const button of container.querySelectorAll<HTMLButtonElement>('.hud-meeting-start')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const workerId = button.dataset.workerId
        if (!workerId || this.meetingActionInFlight) return
        void this.startMeeting(workerId)
      })
    }

    container.querySelector('.hud-meeting-stop')?.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.meetingActionInFlight) return
      void this.stopMeeting()
    })

    for (const button of container.querySelectorAll<HTMLButtonElement>('.hud-meeting-open-log')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const path = button.dataset.path
        if (!path) return
        this.openMeetingFile(path)
      })
    }
  }

  private renderMeetingStartButtons(disabledAttr: string): string {
    return this.cityWorkers
      .map(session => `<button class="hud-meeting-btn hud-meeting-start" data-worker-id="${session.id}" ${disabledAttr}>Start on ${escapeHtml(session.name)}</button>`)
      .join('')
  }

  private openMeetingFile(path: string): void {
    const currentCity = this.getCurrentCity()
    if (!currentCity) return
    this.getOnOpenFile()?.(path, currentCity.originId, currentCity.path, currentCity.id)
  }

  private lookupWorkerName(sessionId: string, fallback: string): string {
    return this.cityWorkers.find(session => session.id === sessionId)?.name ?? fallback
  }

  private selectMeetingForCurrentCity(): MeetingRunState | null {
    const activeMeeting = this.meetingState?.activeMeeting ?? null
    if (activeMeeting && this.belongsToCurrentCity(activeMeeting)) {
      return activeMeeting
    }

    const lastMeeting = this.meetingState?.lastMeeting ?? null
    if (lastMeeting && this.belongsToCurrentCity(lastMeeting)) {
      return lastMeeting
    }

    return null
  }

  private belongsToCurrentCity(meeting: MeetingRunState): boolean {
    const currentCity = this.getCurrentCity()
    return !!currentCity
      && meeting.cityPath === currentCity.path
      && meeting.originId === currentCity.originId
  }

  private startMeetingPolling(): void {
    if (this.meetingPollHandle) return
    this.meetingPollHandle = setInterval(() => {
      void this.refreshMeetingState()
    }, 3000)
  }

  private stopMeetingPolling(): void {
    if (!this.meetingPollHandle) return
    clearInterval(this.meetingPollHandle)
    this.meetingPollHandle = null
  }

  private async refreshMeetingState(): Promise<void> {
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge`)
      if (!response.ok) return
      const data = await response.json() as { meeting?: MeetingBridgeState | null }
      this.meetingState = data.meeting ?? null
      if (this.getCurrentCity()) {
        this.renderMeeting()
      }
    } catch (error) {
      console.warn('[CityHUDHeader] Failed to load meeting bridge state', error)
    }
  }

  private async startMeeting(workerId: string): Promise<void> {
    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workerId }),
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }

      await this.refreshMeetingState()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to start meeting bridge: ${message}`)
    } finally {
      this.meetingActionInFlight = false
      this.renderMeeting()
    }
  }

  private async stopMeeting(): Promise<void> {
    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/stop`, {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }

      await this.refreshMeetingState()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to stop meeting bridge: ${message}`)
    } finally {
      this.meetingActionInFlight = false
      this.renderMeeting()
    }
  }

  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const data = await response.json() as { error?: string }
      return data.error || `${response.status} ${response.statusText}`
    } catch {
      return `${response.status} ${response.statusText}`
    }
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
