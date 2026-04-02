import type { City, GitStatus, Session } from '../state/types'
import { escapeHtml } from './utils'
import type { NewWorkerDialog } from './NewWorkerDialog'
import type { ServerMeetingBridgeState, ServerMeetingRunState } from '../state/types'

const PORTOLAN_HTTP_BASE = `${window.location.protocol === 'https:' ? 'https' : 'http'}://${window.location.hostname}:4004`

interface MeetingThreadItem {
  receivedAt: number
  lane: 'transcript' | 'update' | 'candidate'
  label: string
  text: string
  selectable: boolean
  selected: boolean
  selectionIndex?: number
}

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
  private meetingState: ServerMeetingBridgeState | null = null
  private meetingActionInFlight = false
  private meetingUpdateDraft = ''
  private meetingCandidateTitle = ''
  private meetingCandidateDraft = ''
  private meetingCandidateKind = 'note'
  private selectedTranscriptChunkIndices: number[] = []
  private selectedOperatorUpdateIndices: number[] = []
  private selectedMeetingId: string | null = null

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
    this.cityWorkers = []
    this.meetingState = null
    this.meetingActionInFlight = false
    this.meetingUpdateDraft = ''
    this.meetingCandidateTitle = ''
    this.meetingCandidateDraft = ''
    this.meetingCandidateKind = 'note'
    this.clearMeetingSelections()
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
  }

  updateWorkers(sessions: Session[]): void {
    const currentCity = this.getCurrentCity()
    this.cityWorkers = currentCity
      ? sessions.filter(session => session.cityId === currentCity.id)
      : []
    this.renderWorkers()
  }

  updateMeetingState(meetingState: ServerMeetingBridgeState | null): void {
    this.meetingState = meetingState
    if (this.getCurrentCity()) {
      this.renderMeeting()
    }
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
    const buttonsDisabled = this.renderDisabledAttr(this.meetingActionInFlight)
    this.syncMeetingSelection(cityMeeting)

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
            <span>${cityMeeting.operatorUpdateCount} operator update${cityMeeting.operatorUpdateCount === 1 ? '' : 's'}</span>
            <span>${cityMeeting.candidateEventCount} candidate event${cityMeeting.candidateEventCount === 1 ? '' : 's'}</span>
            <span>${escapeHtml(cityMeeting.sourceType)}</span>
          </div>
          ${this.renderMeetingThread(cityMeeting)}
          ${cityMeeting.lastChunkPreview ? `<div class="hud-meeting-preview">${escapeHtml(cityMeeting.lastChunkPreview)}</div>` : ''}
          ${cityMeeting.lastOperatorUpdatePreview ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest update</span>
              <span>${escapeHtml(cityMeeting.lastOperatorUpdatePreview)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastCandidateEventPreview ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest candidate</span>
              <span>${escapeHtml(cityMeeting.lastCandidateEventPreview)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastError ? `<div class="hud-meeting-error">${escapeHtml(cityMeeting.lastError)}</div>` : ''}
          ${cityMeeting.status === 'running' ? `
            <div class="hud-meeting-update">
              <textarea class="hud-meeting-update-input" placeholder="Correct or steer the live meeting narrative…">${escapeHtml(this.meetingUpdateDraft)}</textarea>
              <div class="hud-meeting-update-actions">
                <button class="hud-meeting-btn hud-meeting-send-update" ${this.renderDisabledAttr(this.meetingActionInFlight || !this.meetingUpdateDraft.trim())}>Send update</button>
              </div>
            </div>
            <div class="hud-meeting-update">
              <div class="hud-meeting-candidate-controls">
                <select class="hud-meeting-candidate-kind" ${buttonsDisabled}>
                  ${this.renderMeetingCandidateKindOptions()}
                </select>
              </div>
              <input class="hud-meeting-candidate-title" type="text" placeholder="Optional title for the accepted item…" value="${escapeHtml(this.meetingCandidateTitle)}" ${buttonsDisabled}>
              ${this.renderMeetingCandidateProvenance(cityMeeting)}
              <textarea class="hud-meeting-update-input hud-meeting-candidate-input" placeholder="Capture an accepted note, question, or decision from this meeting…">${escapeHtml(this.meetingCandidateDraft)}</textarea>
              <div class="hud-meeting-update-actions">
                <button class="hud-meeting-btn hud-meeting-send-candidate" ${this.renderDisabledAttr(this.meetingActionInFlight || !this.meetingCandidateDraft.trim() || !this.hasCandidateProvenanceSelection())}>Capture candidate</button>
              </div>
            </div>
          ` : ''}
          <div class="hud-meeting-actions">
            ${cityMeeting.status === 'running'
              ? `<button class="hud-meeting-btn hud-meeting-stop" ${buttonsDisabled}>Stop</button>`
              : this.renderMeetingStartButtons(buttonsDisabled)}
          </div>
          <div class="hud-meeting-actions hud-meeting-links">
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.transcriptPath)}">Transcript log</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.injectionsPath)}">Worker injections</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.updatesPath)}">Operator updates</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.candidateEventsPath)}">Candidate events</button>
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

    const updateInput = container.querySelector<HTMLTextAreaElement>('.hud-meeting-update-input:not(.hud-meeting-candidate-input)')
    updateInput?.addEventListener('input', () => {
      this.meetingUpdateDraft = updateInput.value
      const sendButton = container.querySelector<HTMLButtonElement>('.hud-meeting-send-update')
      if (sendButton && !this.meetingActionInFlight) {
        sendButton.disabled = this.meetingUpdateDraft.trim().length === 0
      }
    })
    updateInput?.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (!this.meetingActionInFlight && this.meetingUpdateDraft.trim()) {
          void this.sendMeetingUpdate()
        }
      }
    })

    container.querySelector('.hud-meeting-send-update')?.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.meetingActionInFlight || !this.meetingUpdateDraft.trim()) return
      void this.sendMeetingUpdate()
    })

    const candidateKind = container.querySelector<HTMLSelectElement>('.hud-meeting-candidate-kind')
    candidateKind?.addEventListener('change', () => {
      this.meetingCandidateKind = candidateKind.value || 'note'
    })

    const candidateTitle = container.querySelector<HTMLInputElement>('.hud-meeting-candidate-title')
    candidateTitle?.addEventListener('input', () => {
      this.meetingCandidateTitle = candidateTitle.value
    })

    const candidateInput = container.querySelector<HTMLTextAreaElement>('.hud-meeting-candidate-input')
    candidateInput?.addEventListener('input', () => {
      this.meetingCandidateDraft = candidateInput.value
      const sendButton = container.querySelector<HTMLButtonElement>('.hud-meeting-send-candidate')
      if (sendButton && !this.meetingActionInFlight) {
        sendButton.disabled = this.meetingCandidateDraft.trim().length === 0 || !this.hasCandidateProvenanceSelection()
      }
    })
    candidateInput?.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (!this.meetingActionInFlight && this.meetingCandidateDraft.trim()) {
          void this.sendMeetingCandidate()
        }
      }
    })

    container.querySelector('.hud-meeting-send-candidate')?.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.meetingActionInFlight || !this.meetingCandidateDraft.trim()) return
      void this.sendMeetingCandidate()
    })

    container.querySelector('.hud-meeting-clear-provenance')?.addEventListener('click', (event) => {
      event.stopPropagation()
      this.clearMeetingSelections()
      this.renderMeeting()
    })

    for (const button of container.querySelectorAll<HTMLButtonElement>('.hud-meeting-open-log')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const path = button.dataset.path
        if (!path) return
        this.openMeetingFile(path)
      })
    }

    for (const item of container.querySelectorAll<HTMLElement>('.hud-meeting-thread-item[data-selectable="true"]')) {
      const toggle = () => {
        const lane = item.dataset.lane
        const index = Number(item.dataset.index)
        if ((lane !== 'transcript' && lane !== 'update') || !Number.isInteger(index)) return
        this.toggleMeetingSelection(lane, index)
        this.renderMeeting()
      }

      item.addEventListener('click', (event) => {
        event.stopPropagation()
        toggle()
      })
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        toggle()
      })
    }
  }

  private renderMeetingStartButtons(disabledAttr: string): string {
    return this.cityWorkers
      .map(session => `<button class="hud-meeting-btn hud-meeting-start" data-worker-id="${session.id}" ${disabledAttr}>Start on ${escapeHtml(session.name)}</button>`)
      .join('')
  }

  private renderMeetingCandidateKindOptions(): string {
    const options = [
      ['note', 'Accepted note'],
      ['question', 'Open question'],
      ['decision', 'Candidate decision'],
      ['action-item', 'Action item'],
    ] as const

    return options
      .map(([value, label]) => `<option value="${value}"${this.meetingCandidateKind === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('')
  }

  private renderDisabledAttr(disabled: boolean): string {
    return disabled ? 'disabled' : ''
  }

  private renderMeetingCandidateProvenance(meeting: ServerMeetingRunState): string {
    const selectedParts: string[] = []
    if (this.selectedTranscriptChunkIndices.length > 0) {
      selectedParts.push(`chunk ${this.selectedTranscriptChunkIndices.join(', ')}`)
    }
    if (this.selectedOperatorUpdateIndices.length > 0) {
      selectedParts.push(`update ${this.selectedOperatorUpdateIndices.join(', ')}`)
    }

    const emptyMessage = meeting.recentTranscriptChunks.length + meeting.recentOperatorUpdates.length > 0
      ? 'Select transcript or update items from the live thread to cite provenance.'
      : 'Waiting for transcript or operator updates to cite.'

    return `
      <div class="hud-meeting-provenance">
        <div class="hud-meeting-provenance-row">
          <span class="hud-meeting-update-label">candidate provenance</span>
          ${selectedParts.length > 0 ? '<button class="hud-meeting-btn hud-meeting-clear-provenance" type="button">Clear</button>' : ''}
        </div>
        ${selectedParts.length > 0
          ? `<div class="hud-meeting-provenance-selection">${escapeHtml(selectedParts.join(' • '))}</div>`
          : `<div class="hud-meeting-provenance-empty">${escapeHtml(emptyMessage)}</div>`}
      </div>
    `
  }

  private renderMeetingThread(meeting: ServerMeetingRunState): string {
    const items: MeetingThreadItem[] = [
      ...meeting.recentTranscriptChunks.map((chunk) => ({
        receivedAt: chunk.receivedAt,
        lane: 'transcript' as const,
        label: this.describeTranscriptChunk(chunk),
        text: chunk.text,
        selectable: true,
        selected: this.selectedTranscriptChunkIndices.includes(chunk.chunkIndex),
        selectionIndex: chunk.chunkIndex,
      })),
      ...meeting.recentOperatorUpdates.map((update) => ({
        receivedAt: update.receivedAt,
        lane: 'update' as const,
        label: this.describeOperatorUpdate(update),
        text: update.text,
        selectable: true,
        selected: this.selectedOperatorUpdateIndices.includes(update.updateIndex),
        selectionIndex: update.updateIndex,
      })),
      ...meeting.recentCandidateEvents.map((event) => ({
        receivedAt: event.receivedAt,
        lane: 'candidate' as const,
        label: this.describeCandidateEvent(event),
        text: event.title ? `${event.title}: ${event.text}` : event.text,
        selectable: false,
        selected: false,
      })),
    ].sort((left, right) => right.receivedAt - left.receivedAt)

    if (items.length === 0) {
      return ''
    }

    return `
      <div class="hud-meeting-thread">
        <div class="hud-meeting-update-label">live thread</div>
        ${items.map((item) => `
          <div
            class="hud-meeting-thread-item hud-meeting-thread-${item.lane}${item.selectable ? ' selectable' : ''}${item.selected ? ' selected' : ''}"
            ${item.selectable ? `data-selectable="true" data-lane="${item.lane}" data-index="${item.selectionIndex}" tabindex="0" role="button" aria-pressed="${item.selected ? 'true' : 'false'}"` : ''}
          >
            <div class="hud-meeting-thread-meta">
              <span class="hud-meeting-thread-lane">${escapeHtml(item.lane)}</span>
              <span>${escapeHtml(item.label)}</span>
              <span>${escapeHtml(this.relativeTime(item.receivedAt))}</span>
              ${item.selectable ? `<span class="hud-meeting-thread-select">${item.selected ? 'cited' : 'click to cite'}</span>` : ''}
            </div>
            <div class="hud-meeting-thread-text">${escapeHtml(item.text)}</div>
          </div>
        `).join('')}
      </div>
    `
  }

  private describeTranscriptChunk(chunk: ServerMeetingRunState['recentTranscriptChunks'][number]): string {
    const parts = [`chunk ${chunk.chunkIndex}`]
    if (chunk.speaker) parts.push(chunk.speaker)
    if (chunk.status) parts.push(chunk.status)
    if (chunk.timestampLocal) parts.push(chunk.timestampLocal)
    return parts.join(' • ')
  }

  private describeOperatorUpdate(update: ServerMeetingRunState['recentOperatorUpdates'][number]): string {
    return update.kind
      ? `update ${update.updateIndex} • ${update.kind}`
      : `update ${update.updateIndex}`
  }

  private describeCandidateEvent(event: ServerMeetingRunState['recentCandidateEvents'][number]): string {
    const parts = [`candidate ${event.eventIndex}`, event.kind]
    if (event.transcriptChunkIndices.length > 0) {
      parts.push(`chunk ${event.transcriptChunkIndices.join(', ')}`)
    }
    if (event.operatorUpdateIndices.length > 0) {
      parts.push(`update ${event.operatorUpdateIndices.join(', ')}`)
    }
    return parts.join(' • ')
  }

  private syncMeetingSelection(meeting: ServerMeetingRunState | null): void {
    if (!meeting) {
      this.clearMeetingSelections()
      return
    }

    if (this.selectedMeetingId !== meeting.meetingId) {
      this.selectedMeetingId = meeting.meetingId
      this.selectedTranscriptChunkIndices = []
      this.selectedOperatorUpdateIndices = []
      return
    }

    const availableChunks = new Set(meeting.recentTranscriptChunks.map((chunk) => chunk.chunkIndex))
    const availableUpdates = new Set(meeting.recentOperatorUpdates.map((update) => update.updateIndex))
    this.selectedTranscriptChunkIndices = this.selectedTranscriptChunkIndices.filter((index) => availableChunks.has(index))
    this.selectedOperatorUpdateIndices = this.selectedOperatorUpdateIndices.filter((index) => availableUpdates.has(index))
  }

  private clearMeetingSelections(): void {
    this.selectedTranscriptChunkIndices = []
    this.selectedOperatorUpdateIndices = []
    this.selectedMeetingId = null
  }

  private hasCandidateProvenanceSelection(): boolean {
    return this.selectedTranscriptChunkIndices.length > 0 || this.selectedOperatorUpdateIndices.length > 0
  }

  private toggleMeetingSelection(lane: 'transcript' | 'update', index: number): void {
    if (lane === 'transcript') {
      this.selectedTranscriptChunkIndices = this.toggleIndexSelection(this.selectedTranscriptChunkIndices, index)
      return
    }
    this.selectedOperatorUpdateIndices = this.toggleIndexSelection(this.selectedOperatorUpdateIndices, index)
  }

  private toggleIndexSelection(indices: number[], index: number): number[] {
    if (indices.includes(index)) {
      return indices.filter((value) => value !== index)
    }
    return [...indices, index].sort((left, right) => left - right)
  }

  private openMeetingFile(path: string): void {
    const currentCity = this.getCurrentCity()
    if (!currentCity) return
    this.getOnOpenFile()?.(path, currentCity.originId, currentCity.path, currentCity.id)
  }

  private lookupWorkerName(sessionId: string, fallback: string): string {
    return this.cityWorkers.find(session => session.id === sessionId)?.name ?? fallback
  }

  private selectMeetingForCurrentCity(): ServerMeetingRunState | null {
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

  private belongsToCurrentCity(meeting: ServerMeetingRunState): boolean {
    const currentCity = this.getCurrentCity()
    return !!currentCity
      && meeting.cityPath === currentCity.path
      && meeting.originId === currentCity.originId
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
      this.clearMeetingSelections()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to stop meeting bridge: ${message}`)
    } finally {
      this.meetingActionInFlight = false
      this.renderMeeting()
    }
  }

  private async sendMeetingUpdate(): Promise<void> {
    const text = this.meetingUpdateDraft.trim()
    if (!text) return

    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }

      this.meetingUpdateDraft = ''
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to send meeting update: ${message}`)
    } finally {
      this.meetingActionInFlight = false
      this.renderMeeting()
    }
  }

  private async sendMeetingCandidate(): Promise<void> {
    const text = this.meetingCandidateDraft.trim()
    const cityMeeting = this.selectMeetingForCurrentCity()
    if (!text || !cityMeeting || !this.hasCandidateProvenanceSelection()) return

    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/candidate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: this.meetingCandidateKind,
          title: this.meetingCandidateTitle.trim() || undefined,
          text,
          transcriptChunkIndices: this.selectedTranscriptChunkIndices,
          operatorUpdateIndices: this.selectedOperatorUpdateIndices,
        }),
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }

      this.meetingCandidateTitle = ''
      this.meetingCandidateDraft = ''
      this.selectedTranscriptChunkIndices = []
      this.selectedOperatorUpdateIndices = []
      this.selectedMeetingId = cityMeeting.meetingId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to capture meeting candidate: ${message}`)
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
