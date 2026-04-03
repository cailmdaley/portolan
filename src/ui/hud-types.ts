// Shared types for CityHUD

export interface Fiber {
  id: string
  title: string
  status: string
  kind: string
  priority: number
  createdAt: string
  body?: string
  reason?: string
}

export interface SearchResult {
  type: 'file' | 'dir'
  path: string
  fullPath: string
  line?: number
  match?: string
}

export interface DirectoryEntry {
  name: string
  type: 'file' | 'dir'
}

export interface MeetingRunState {
  recentTranscriptChunks: Array<{
    chunkIndex: number
    receivedAt: number
    revisionIndex?: number
    sourceChunkId?: string
    timestampLocal?: string
    status?: string
    speaker?: string
    isPartial?: boolean
    isRevision?: boolean
    text: string
  }>
  recentOperatorUpdates: Array<{
    updateIndex: number
    receivedAt: number
    kind?: string
    text: string
  }>
  recentAssistantResponses: Array<{
    responseIndex: number
    receivedAt: number
    timestamp?: string
    text: string
  }>
  recentCandidateEvents: Array<{
    eventIndex: number
    receivedAt: number
    kind: string
    title?: string
    text: string
    transcriptChunkIndices: number[]
    operatorUpdateIndices: number[]
    promotedAstraDecisionId?: string
  }>
  recentRetrievalRequests: Array<{
    requestIndex: number
    receivedAt: number
    text: string
  }>
  meetingId: string
  status: 'running' | 'stopped' | 'error'
  sourceType: 'voiceink' | 'manual'
  startedAt: number
  stoppedAt?: number
  sessionId: string
  tmuxSession: string
  originId: string
  sshHost?: string
  cityPath: string
  transcriptPath: string
  injectionsPath: string
  updatesPath: string
  assistantResponsesPath: string
  candidateEventsPath: string
  retrievalRequestsPath: string
  metadataPath: string
  bootstrapSentAt?: number
  chunkCount: number
  injectedCount: number
  operatorUpdateCount: number
  assistantResponseCount: number
  candidateEventCount: number
  promotedCandidateEventCount: number
  retrievalRequestCount: number
  lastChunkAt?: number
  lastChunkPreview?: string
  lastOperatorUpdateAt?: number
  lastOperatorUpdatePreview?: string
  lastAssistantResponseAt?: number
  lastAssistantResponsePreview?: string
  lastCandidateEventAt?: number
  lastCandidateEventPreview?: string
  lastPromotedCandidateAt?: number
  lastPromotedCandidateFiberId?: string
  lastPromotedCandidateAstraDecisionId?: string
  lastRetrievalRequestAt?: number
  lastRetrievalRequestPreview?: string
  lastError?: string
}

export interface MeetingBridgeState {
  activeMeeting: MeetingRunState | null
  lastMeeting: MeetingRunState | null
}
