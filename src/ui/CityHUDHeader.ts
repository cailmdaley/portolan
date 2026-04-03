import type { City, GitStatus, Session } from '../state/types'
import { escapeHtml } from './utils'
import type { NewWorkerDialog } from './NewWorkerDialog'
import type { ServerMeetingBridgeState, ServerMeetingRunState } from '../state/types'
import type { Fiber, SearchResult } from './hud-types'

const PORTOLAN_HTTP_BASE = `${window.location.protocol === 'https:' ? 'https' : 'http'}://${window.location.hostname}:4004`

interface MeetingThreadItem {
  receivedAt: number
  lane: 'transcript' | 'update' | 'assistant' | 'candidate' | 'retrieval' | 'evidence'
  label: string
  text: string
  selectable: boolean
  selected: boolean
  selectionIndex?: number
  promotedFiberId?: string
  promotedAstraDecisionId?: string
}

interface SearchResultsMessage {
  type: 'searchResults'
  searchId: string
  results: SearchResult[]
  error?: string
}

interface MeetingRetrievalResult {
  type: 'fiber' | 'file' | 'dir'
  id: string
  title: string
  path?: string
  line?: number
  match?: string
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
  getFibers: () => { open: Fiber[]; closed: Fiber[] }
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
  private getFibers: () => { open: Fiber[]; closed: Fiber[] }
  private cityWorkers: Session[] = []
  private meetingState: ServerMeetingBridgeState | null = null
  private meetingActionInFlight = false
  private meetingUpdateDraft = ''
  private meetingUpdateKind = 'correction'
  private meetingCandidateTitle = ''
  private meetingCandidateDraft = ''
  private meetingCandidateKind = 'note'
  private meetingRetrievalDraft = ''
  private retrievalResults: MeetingRetrievalResult[] = []
  private retrievalSearchToken = 0
  private retrievalSearchPending = false
  private retrievalResultRequestIndex: number | null = null
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
    this.getFibers = options.getFibers
  }

  reset(): void {
    this.cityWorkers = []
    this.meetingState = null
    this.meetingActionInFlight = false
    this.meetingUpdateDraft = ''
    this.meetingUpdateKind = 'correction'
    this.meetingCandidateTitle = ''
    this.meetingCandidateDraft = ''
    this.meetingCandidateKind = 'note'
    this.meetingRetrievalDraft = ''
    this.retrievalResults = []
    this.retrievalSearchPending = false
    this.retrievalResultRequestIndex = null
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

  handleMessage(message: unknown): boolean {
    const currentCity = this.getCurrentCity()
    if (!currentCity) return false
    const msg = message as { type?: string }
    if (msg.type !== 'searchResults') return false
    const response = message as SearchResultsMessage
    const prefix = `${currentCity.id}-meeting-retrieval-${this.retrievalSearchToken}`
    if (!response.searchId.startsWith(prefix)) return false

    if (response.error) {
      this.retrievalSearchPending = false
      this.renderMeeting()
      return true
    }

    const fileResults: MeetingRetrievalResult[] = response.results.map((result) => ({
      type: result.type,
      id: `${result.fullPath}:${result.line ?? 0}`,
      title: result.path,
      path: result.fullPath,
      line: result.line,
      match: result.match,
    }))
    this.mergeRetrievalResults(fileResults)
    if (response.searchId.endsWith('-content')) {
      this.retrievalSearchPending = false
    }
    this.renderMeeting()
    return true
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
            <span>${cityMeeting.assistantResponseCount} assistant response${cityMeeting.assistantResponseCount === 1 ? '' : 's'}</span>
            <span>${cityMeeting.candidateEventCount} candidate event${cityMeeting.candidateEventCount === 1 ? '' : 's'}</span>
            <span>${cityMeeting.promotedCandidateEventCount} promoted</span>
            <span>${cityMeeting.retrievalRequestCount} retrieval request${cityMeeting.retrievalRequestCount === 1 ? '' : 's'}</span>
            <span>${cityMeeting.retrievalEvidenceCount} evidence pull${cityMeeting.retrievalEvidenceCount === 1 ? '' : 's'}</span>
            <span>${escapeHtml(this.describeMeetingSourceType(cityMeeting.sourceType))}</span>
          </div>
          ${this.renderMeetingBrief(cityMeeting)}
          ${this.renderMeetingIngressHint(cityMeeting)}
          ${this.renderMeetingThread(cityMeeting)}
          ${cityMeeting.lastChunkPreview ? `<div class="hud-meeting-preview">${escapeHtml(cityMeeting.lastChunkPreview)}</div>` : ''}
          ${cityMeeting.lastOperatorUpdatePreview ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest update</span>
              <span>${escapeHtml(cityMeeting.lastOperatorUpdatePreview)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastAssistantResponsePreview ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest assistant</span>
              <span>${escapeHtml(cityMeeting.lastAssistantResponsePreview)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastCandidateEventPreview ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest candidate</span>
              <span>${escapeHtml(cityMeeting.lastCandidateEventPreview)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastPromotedCandidateFiberId ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest promotion</span>
              <span>${escapeHtml(cityMeeting.lastPromotedCandidateFiberId)}${cityMeeting.lastPromotedCandidateAstraDecisionId ? ` • ASTRA ${escapeHtml(cityMeeting.lastPromotedCandidateAstraDecisionId)}` : ''}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastRetrievalRequestPreview ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest retrieval</span>
              <span>${escapeHtml(cityMeeting.lastRetrievalRequestPreview)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastRetrievedEvidencePreview ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest evidence</span>
              <span>${escapeHtml(cityMeeting.lastRetrievedEvidencePreview)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastBriefPromotionFiberId ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">latest brief</span>
              <span>${escapeHtml(cityMeeting.lastBriefPromotionFiberId)}${cityMeeting.lastBriefPromotionAstraAnalysisId ? ` • ASTRA ${escapeHtml(cityMeeting.lastBriefPromotionAstraAnalysisId)}` : ''}</span>
            </div>
          ` : ''}
          ${cityMeeting.liveAstraAnalysisId ? `
            <div class="hud-meeting-update-preview">
              <span class="hud-meeting-update-label">live ASTRA</span>
              <span>${escapeHtml(cityMeeting.liveAstraAnalysisId)}</span>
            </div>
          ` : ''}
          ${cityMeeting.lastError ? `<div class="hud-meeting-error">${escapeHtml(cityMeeting.lastError)}</div>` : ''}
          ${cityMeeting.status === 'running' ? `
            <div class="hud-meeting-update">
              <div class="hud-meeting-update-label">retrieval</div>
              <div class="hud-meeting-update-actions">
                <input class="hud-meeting-retrieval-input" type="text" placeholder="Pull up a plot, fiber, artifact, or evidence chain…" value="${escapeHtml(this.meetingRetrievalDraft)}" ${buttonsDisabled}>
                <button class="hud-meeting-btn hud-meeting-search-retrieval" ${this.renderDisabledAttr(this.meetingActionInFlight || !this.meetingRetrievalDraft.trim())}>Search</button>
                <button class="hud-meeting-btn hud-meeting-send-retrieval" ${this.renderDisabledAttr(this.meetingActionInFlight || !this.meetingRetrievalDraft.trim())}>Ask assistant</button>
              </div>
              ${this.renderMeetingRetrievalResults()}
            </div>
            <div class="hud-meeting-update">
              <div class="hud-meeting-candidate-controls">
                <select class="hud-meeting-update-kind" ${buttonsDisabled}>
                  ${this.renderMeetingUpdateKindOptions()}
                </select>
              </div>
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
            <div class="hud-meeting-actions">
              <button class="hud-meeting-btn hud-meeting-promote-brief" ${this.renderDisabledAttr(this.meetingActionInFlight || !this.hasPromotableMeetingBrief(cityMeeting))}>Promote brief</button>
            </div>
          ` : ''}
          <div class="hud-meeting-actions">
            ${cityMeeting.status === 'running'
              ? `<button class="hud-meeting-btn hud-meeting-stop" ${buttonsDisabled}>Stop</button>`
              : this.renderMeetingStartButtons(buttonsDisabled)}
          </div>
          <div class="hud-meeting-actions hud-meeting-links">
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.liveDocumentPath)}">Live document</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.liveAstraPath)}">Live ASTRA</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.transcriptPath)}">Transcript log</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.injectionsPath)}">Worker injections</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.updatesPath)}">Operator updates</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.assistantResponsesPath)}">Assistant replies</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.candidateEventsPath)}">Candidate events</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.candidatePromotionsPath)}">Candidate promotions</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.retrievalRequestsPath)}">Retrieval requests</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.retrievalEvidencePath)}">Retrieved evidence</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.briefPromotionsPath)}">Brief promotions</button>
            <button class="hud-meeting-btn hud-meeting-open-log" data-path="${escapeHtml(cityMeeting.metadataPath)}">Meeting metadata</button>
          </div>
        </div>
      `)
    } else if (this.cityWorkers.length > 0) {
      lines.push(`
        <div class="hud-meeting-card">
          <div class="hud-meeting-meta">
            <span>${meetingElsewhere ? 'another meeting is active elsewhere; starting here will replace it' : 'start a VoiceInk bridge or open a manual HTTP ingress run on a worker'}</span>
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
        const sourceType = button.dataset.sourceType === 'manual' ? 'manual' : 'voiceink'
        if (!workerId || this.meetingActionInFlight) return
        void this.startMeeting(workerId, sourceType)
      })
    }

    container.querySelector('.hud-meeting-stop')?.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.meetingActionInFlight) return
      void this.stopMeeting()
    })

    const updateInput = container.querySelector<HTMLTextAreaElement>('.hud-meeting-update-input:not(.hud-meeting-candidate-input)')
    const updateKind = container.querySelector<HTMLSelectElement>('.hud-meeting-update-kind')
    const retrievalInput = container.querySelector<HTMLInputElement>('.hud-meeting-retrieval-input')
    retrievalInput?.addEventListener('input', () => {
      this.meetingRetrievalDraft = retrievalInput.value
      const retrievalDisabled = this.meetingActionInFlight || this.meetingRetrievalDraft.trim().length === 0
      const searchButton = container.querySelector<HTMLButtonElement>('.hud-meeting-search-retrieval')
      const sendButton = container.querySelector<HTMLButtonElement>('.hud-meeting-send-retrieval')
      if (searchButton) searchButton.disabled = retrievalDisabled
      if (sendButton) sendButton.disabled = retrievalDisabled
    })
    retrievalInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (!this.meetingActionInFlight && this.meetingRetrievalDraft.trim()) {
          this.runMeetingRetrievalSearch()
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (!this.meetingActionInFlight && this.meetingRetrievalDraft.trim()) {
          void this.sendMeetingRetrieval()
        }
      }
    })

    container.querySelector('.hud-meeting-search-retrieval')?.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.meetingActionInFlight || !this.meetingRetrievalDraft.trim()) return
      this.runMeetingRetrievalSearch()
    })

    container.querySelector('.hud-meeting-send-retrieval')?.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.meetingActionInFlight || !this.meetingRetrievalDraft.trim()) return
      void this.sendMeetingRetrieval()
    })

    updateKind?.addEventListener('change', () => {
      this.meetingUpdateKind = updateKind.value || 'correction'
    })

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

    container.querySelector('.hud-meeting-promote-brief')?.addEventListener('click', (event) => {
      event.stopPropagation()
      const meeting = this.selectMeetingForCurrentCity()
      if (this.meetingActionInFlight || !meeting || !this.hasPromotableMeetingBrief(meeting)) return
      void this.promoteMeetingBrief()
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

    for (const button of container.querySelectorAll<HTMLButtonElement>('.hud-meeting-promote-candidate')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (this.meetingActionInFlight) return
        const eventIndex = Number(button.dataset.eventIndex)
        if (!Number.isInteger(eventIndex)) return
        void this.promoteMeetingCandidate(eventIndex)
      })
    }

    for (const item of container.querySelectorAll<HTMLElement>('.hud-meeting-retrieval-result')) {
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        const type = item.dataset.type
        if (type === 'fiber') {
          const fiberId = item.dataset.id
          this.openMeetingFiber(fiberId)
          void this.recordMeetingRetrievedEvidence({
            type: 'fiber',
            title: item.dataset.title ?? fiberId ?? 'Fiber',
            fiberId,
            match: item.dataset.match,
          })
          return
        }
        const path = item.dataset.path
        if (!path) return
        this.openMeetingFile(path, item.dataset.line ? parseInt(item.dataset.line, 10) : undefined)
        void this.recordMeetingRetrievedEvidence({
          type: 'file',
          title: item.dataset.title ?? path,
          path,
          line: item.dataset.line ? parseInt(item.dataset.line, 10) : undefined,
          match: item.dataset.match,
        })
      })
    }

    for (const button of container.querySelectorAll<HTMLButtonElement>('.hud-meeting-open-promoted-fiber')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        this.openMeetingFiber(button.dataset.fiberId)
      })
    }
  }

  private renderMeetingStartButtons(disabledAttr: string): string {
    return this.cityWorkers
      .map(session => `
        <button class="hud-meeting-btn hud-meeting-start" data-worker-id="${session.id}" data-source-type="voiceink" ${disabledAttr}>VoiceInk → ${escapeHtml(session.name)}</button>
        <button class="hud-meeting-btn hud-meeting-start" data-worker-id="${session.id}" data-source-type="manual" ${disabledAttr}>Manual → ${escapeHtml(session.name)}</button>
      `)
      .join('')
  }

  private describeMeetingSourceType(sourceType: ServerMeetingRunState['sourceType']): string {
    return sourceType === 'manual' ? 'manual ingress' : 'voiceink'
  }

  private renderMeetingIngressHint(meeting: ServerMeetingRunState): string {
    if (meeting.status !== 'running') {
      return ''
    }
    if (meeting.sourceType === 'manual') {
      return `
        <div class="hud-meeting-provenance-empty">
          Manual ingress is active. Send transcript chunks to <code>POST /meeting-bridge/chunk</code> or <code>POST /meeting-bridge/chunks</code>.
        </div>
      `
    }
    return `
      <div class="hud-meeting-provenance-empty">
        VoiceInk ingress is active. Completed transcript rows will be bridged into this worker automatically.
      </div>
    `
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

  private renderMeetingUpdateKindOptions(): string {
    const options = [
      ['correction', 'Correction'],
      ['narrative', 'Narrative state'],
      ['redirect', 'Redirect'],
      ['question', 'Open issue'],
    ] as const

    return options
      .map(([value, label]) => `<option value="${value}"${this.meetingUpdateKind === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('')
  }

  private renderMeetingRetrievalResults(): string {
    if (!this.meetingRetrievalDraft.trim() && this.retrievalResults.length === 0 && !this.retrievalSearchPending) {
      return ''
    }

    if (this.retrievalSearchPending) {
      return '<div class="hud-meeting-provenance-empty">Searching local fibers and files…</div>'
    }

    if (this.retrievalResults.length === 0) {
      return '<div class="hud-meeting-provenance-empty">No local retrieval matches yet.</div>'
    }

    return `
      <div class="hud-meeting-thread">
        <div class="hud-meeting-update-label">retrieval results</div>
        ${this.retrievalResults.slice(0, 8).map((result) => `
          <div
            class="hud-meeting-thread-item hud-meeting-retrieval-result"
            data-type="${escapeHtml(result.type)}"
            data-title="${escapeHtml(result.title)}"
            ${result.path ? `data-path="${escapeHtml(result.path)}"` : ''}
            ${result.line ? `data-line="${result.line}"` : ''}
            ${result.id ? `data-id="${escapeHtml(result.id)}"` : ''}
            ${result.match ? `data-match="${escapeHtml(result.match)}"` : ''}
            tabindex="0"
            role="button"
          >
            <div class="hud-meeting-thread-meta">
              <span class="hud-meeting-thread-lane">${escapeHtml(result.type)}</span>
              <span>${escapeHtml(result.title)}</span>
              <span>${result.type === 'fiber' ? 'open fiber' : 'open file'}</span>
            </div>
            ${result.match ? `<div class="hud-meeting-thread-text">${escapeHtml(result.match)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `
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

  private renderMeetingBrief(meeting: ServerMeetingRunState): string {
    const brief = meeting.liveBrief
    const hasContent = !!brief.currentNarrative
      || brief.decisions.length > 0
      || brief.openQuestions.length > 0
      || brief.actionItems.length > 0
      || brief.acceptedNotes.length > 0
      || brief.evidenceInView.length > 0

    if (!hasContent) {
      return ''
    }

    return `
      <div class="hud-meeting-brief">
        <div class="hud-meeting-update-label">current stance</div>
        ${brief.currentNarrative ? `
          <div class="hud-meeting-brief-narrative">
            <div class="hud-meeting-thread-meta">
              <span class="hud-meeting-thread-lane">operator</span>
              <span>${escapeHtml(this.describeOperatorUpdate(brief.currentNarrative))}</span>
              <span>${escapeHtml(this.relativeTime(brief.currentNarrative.receivedAt))}</span>
            </div>
            <div class="hud-meeting-thread-text">${escapeHtml(brief.currentNarrative.text)}</div>
          </div>
        ` : ''}
        ${this.renderMeetingBriefLane('decisions', brief.decisions)}
        ${this.renderMeetingBriefLane('open questions', brief.openQuestions)}
        ${this.renderMeetingBriefLane('action items', brief.actionItems)}
        ${this.renderMeetingBriefLane('accepted notes', brief.acceptedNotes)}
        ${brief.evidenceInView.length > 0 ? `
          <div class="hud-meeting-brief-section">
            <div class="hud-meeting-update-label">evidence in view</div>
            ${brief.evidenceInView.map((item) => `
              <div class="hud-meeting-brief-item">
                <div class="hud-meeting-thread-meta">
                  <span class="hud-meeting-thread-lane">${escapeHtml(item.type)}</span>
                  <span>${escapeHtml(item.title)}</span>
                  <span>${escapeHtml(this.relativeTime(item.receivedAt))}</span>
                </div>
                ${item.match ? `<div class="hud-meeting-thread-text">${escapeHtml(item.match)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `
  }

  private hasPromotableMeetingBrief(meeting: ServerMeetingRunState): boolean {
    const brief = meeting.liveBrief
    return !!brief.currentNarrative
      || brief.decisions.length > 0
      || brief.openQuestions.length > 0
      || brief.actionItems.length > 0
      || brief.acceptedNotes.length > 0
      || brief.evidenceInView.length > 0
  }

  private renderMeetingBriefLane(
    label: string,
    items: ServerMeetingRunState['liveBrief']['decisions'],
  ): string {
    if (items.length === 0) {
      return ''
    }

    return `
      <div class="hud-meeting-brief-section">
        <div class="hud-meeting-update-label">${escapeHtml(label)}</div>
        ${items.map((item) => `
          <div class="hud-meeting-brief-item">
            <div class="hud-meeting-thread-meta">
              <span class="hud-meeting-thread-lane">${escapeHtml(item.kind)}</span>
              <span>${escapeHtml(item.title ?? `candidate ${item.eventIndex}`)}</span>
              <span>${escapeHtml(this.relativeTime(item.receivedAt))}</span>
              ${item.promotedFiberId ? `<span class="hud-meeting-thread-select">promoted → ${escapeHtml(item.promotedFiberId)}${item.promotedAstraDecisionId ? ` • ASTRA ${escapeHtml(item.promotedAstraDecisionId)}` : ''}</span>` : ''}
            </div>
            <div class="hud-meeting-thread-text">${escapeHtml(item.text)}</div>
          </div>
        `).join('')}
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
      ...meeting.recentAssistantResponses.map((response) => ({
        receivedAt: response.receivedAt,
        lane: 'assistant' as const,
        label: this.describeAssistantResponse(response),
        text: response.text,
        selectable: false,
        selected: false,
      })),
      ...meeting.recentCandidateEvents.map((event) => ({
        receivedAt: event.receivedAt,
        lane: 'candidate' as const,
        label: this.describeCandidateEvent(event),
        text: event.title ? `${event.title}: ${event.text}` : event.text,
        selectable: false,
        selected: false,
        selectionIndex: event.eventIndex,
        promotedFiberId: event.promotedFiberId,
        promotedAstraDecisionId: event.promotedAstraDecisionId,
      })),
      ...meeting.recentRetrievalRequests.map((request) => ({
        receivedAt: request.receivedAt,
        lane: 'retrieval' as const,
        label: this.describeRetrievalRequest(request),
        text: request.text,
        selectable: false,
        selected: false,
      })),
      ...meeting.recentRetrievedEvidence.map((evidence) => ({
        receivedAt: evidence.receivedAt,
        lane: 'evidence' as const,
        label: this.describeRetrievedEvidence(evidence),
        text: evidence.match ? `${evidence.title}: ${evidence.match}` : evidence.title,
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
              ${item.lane === 'candidate' && item.promotedFiberId ? `<span class="hud-meeting-thread-select">promoted → ${escapeHtml(item.promotedFiberId)}${item.promotedAstraDecisionId ? ` • ASTRA ${escapeHtml(item.promotedAstraDecisionId)}` : ''}</span>` : ''}
            </div>
            <div class="hud-meeting-thread-text">${escapeHtml(item.text)}</div>
            ${item.lane === 'candidate'
              ? `<div class="hud-meeting-update-actions">
                  ${item.promotedFiberId
                    ? `<button class="hud-meeting-btn hud-meeting-open-promoted-fiber" data-fiber-id="${escapeHtml(item.promotedFiberId)}">Open fiber</button>`
                    : `<button class="hud-meeting-btn hud-meeting-promote-candidate" data-event-index="${item.selectionIndex}" ${this.renderDisabledAttr(this.meetingActionInFlight)}>Promote to felt</button>`}
                </div>`
              : ''}
          </div>
        `).join('')}
      </div>
    `
  }

  private describeTranscriptChunk(chunk: ServerMeetingRunState['recentTranscriptChunks'][number]): string {
    const parts = [`chunk ${chunk.chunkIndex}`]
    if (chunk.revisionIndex && chunk.revisionIndex > 1) parts.push(`rev ${chunk.revisionIndex}`)
    if (chunk.speaker) parts.push(chunk.speaker)
    if (chunk.isPartial) {
      parts.push('tentative')
    }
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

  private describeAssistantResponse(response: ServerMeetingRunState['recentAssistantResponses'][number]): string {
    const parts = [`assistant ${response.responseIndex}`]
    if (response.timestamp) parts.push(response.timestamp)
    return parts.join(' • ')
  }

  private describeRetrievalRequest(request: ServerMeetingRunState['recentRetrievalRequests'][number]): string {
    return `retrieval ${request.requestIndex}`
  }

  private describeRetrievedEvidence(evidence: ServerMeetingRunState['recentRetrievedEvidence'][number]): string {
    const parts = [`evidence ${evidence.evidenceIndex}`, evidence.type]
    if (evidence.requestIndex) parts.push(`request ${evidence.requestIndex}`)
    if (evidence.line) parts.push(`line ${evidence.line}`)
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
      this.retrievalResultRequestIndex = null
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
    this.retrievalResultRequestIndex = null
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

  private openMeetingFile(path: string, line?: number): void {
    const currentCity = this.getCurrentCity()
    if (!currentCity) return
    this.getOnOpenFile()?.(path, currentCity.originId, currentCity.path, currentCity.id, line)
  }

  private openMeetingFiber(fiberId: string | undefined): void {
    const currentCity = this.getCurrentCity()
    if (!currentCity || !fiberId) return
    this.openMeetingFile(`${currentCity.path}/.felt/${fiberId}/${fiberId}.md`)
  }

  private async recordMeetingRetrievedEvidence(evidence: {
    type: 'fiber' | 'file'
    title: string
    fiberId?: string
    path?: string
    line?: number
    match?: string
  }): Promise<void> {
    const cityMeeting = this.selectMeetingForCurrentCity()
    if (!cityMeeting || cityMeeting.status !== 'running') return

    try {
      await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/retrieval/evidence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...evidence,
          requestIndex: this.retrievalResultRequestIndex ?? undefined,
        }),
      })
    } catch {
      // Opening the evidence should still work even if meeting bookkeeping fails.
    }
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

  private async startMeeting(workerId: string, sourceType: ServerMeetingRunState['sourceType'] = 'voiceink'): Promise<void> {
    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workerId, sourceType }),
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const sourceLabel = sourceType === 'manual' ? 'manual meeting ingress' : 'VoiceInk meeting bridge'
      window.alert(`Failed to start ${sourceLabel}: ${message}`)
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
        body: JSON.stringify({ text, kind: this.meetingUpdateKind }),
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

  private async sendMeetingRetrieval(): Promise<void> {
    const text = this.meetingRetrievalDraft.trim()
    if (!text) return

    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      this.runMeetingRetrievalSearch()
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/retrieval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }

      const data = await response.json() as { meeting?: ServerMeetingRunState }
      this.retrievalResultRequestIndex = data.meeting?.retrievalRequestCount ?? null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to send retrieval request: ${message}`)
    } finally {
      this.meetingActionInFlight = false
      this.renderMeeting()
    }
  }

  private async promoteMeetingCandidate(eventIndex: number): Promise<void> {
    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/candidate/promote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ eventIndex }),
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to promote meeting candidate: ${message}`)
    } finally {
      this.meetingActionInFlight = false
      this.renderMeeting()
    }
  }

  private async promoteMeetingBrief(): Promise<void> {
    this.meetingActionInFlight = true
    this.renderMeeting()
    try {
      const response = await fetch(`${PORTOLAN_HTTP_BASE}/meeting-bridge/brief/promote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Failed to promote meeting brief: ${message}`)
    } finally {
      this.meetingActionInFlight = false
      this.renderMeeting()
    }
  }

  private runMeetingRetrievalSearch(): void {
    const currentCity = this.getCurrentCity()
    const ws = this.getWebSocket()
    const query = this.meetingRetrievalDraft.trim()
    if (!currentCity || !query) return

    this.retrievalResults = this.findMatchingFibers(query)
    this.retrievalSearchPending = true
    this.retrievalSearchToken += 1
    this.renderMeeting()

    if (ws?.readyState !== WebSocket.OPEN) {
      this.retrievalSearchPending = false
      this.renderMeeting()
      return
    }

    const searchBase = `${currentCity.id}-meeting-retrieval-${this.retrievalSearchToken}`
    ws.send(JSON.stringify({
      type: 'searchFiles',
      cityId: currentCity.id,
      query,
      searchId: `${searchBase}-name`,
      mode: 'filename',
    }))
    ws.send(JSON.stringify({
      type: 'searchFiles',
      cityId: currentCity.id,
      query,
      searchId: `${searchBase}-content`,
      mode: 'content',
    }))
  }

  private findMatchingFibers(query: string): MeetingRetrievalResult[] {
    const normalized = query.toLowerCase()
    return [...this.getFibers().open, ...this.getFibers().closed]
      .filter((fiber) =>
        fiber.title.toLowerCase().includes(normalized)
        || fiber.id.toLowerCase().includes(normalized)
        || fiber.kind.toLowerCase().includes(normalized)
        || (fiber.body?.toLowerCase().includes(normalized) ?? false)
        || (fiber.reason?.toLowerCase().includes(normalized) ?? false),
      )
      .slice(0, 4)
      .map((fiber) => ({
        type: 'fiber',
        id: fiber.id,
        title: fiber.title,
        match: fiber.reason || fiber.body,
      }))
  }

  private mergeRetrievalResults(results: MeetingRetrievalResult[]): void {
    for (const result of results) {
      if (this.retrievalResults.some((existing) => existing.type === result.type && existing.id === result.id)) {
        continue
      }
      this.retrievalResults.push(result)
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
