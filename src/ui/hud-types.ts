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
  liveBrief: {
    currentNarrative?: {
      updateIndex: number
      receivedAt: number
      kind?: string
      text: string
    }
    decisions: Array<{
      eventIndex: number
      receivedAt: number
      kind: string
      title?: string
      text: string
      transcriptChunkIndices: number[]
      operatorUpdateIndices: number[]
      promotedAt?: number
      promotedFiberId?: string
      promotedAstraDecisionId?: string
    }>
    openQuestions: Array<{
      eventIndex: number
      receivedAt: number
      kind: string
      title?: string
      text: string
      transcriptChunkIndices: number[]
      operatorUpdateIndices: number[]
      promotedAt?: number
      promotedFiberId?: string
      promotedAstraDecisionId?: string
    }>
    actionItems: Array<{
      eventIndex: number
      receivedAt: number
      kind: string
      title?: string
      text: string
      transcriptChunkIndices: number[]
      operatorUpdateIndices: number[]
      promotedAt?: number
      promotedFiberId?: string
      promotedAstraDecisionId?: string
    }>
    acceptedNotes: Array<{
      eventIndex: number
      receivedAt: number
      kind: string
      title?: string
      text: string
      transcriptChunkIndices: number[]
      operatorUpdateIndices: number[]
      promotedAt?: number
      promotedFiberId?: string
      promotedAstraDecisionId?: string
    }>
    evidenceInView: Array<{
      evidenceIndex: number
      receivedAt: number
      requestIndex?: number
      type: 'fiber' | 'file'
      title: string
      fiberId?: string
      path?: string
      line?: number
      match?: string
    }>
  }
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
  startedAt: number
  stoppedAt?: number
  sessionId: string
  tmuxSession: string
  originId: string
  sshHost?: string
  cityPath: string
  transcriptPath: string
  transcriptMarkdownPath: string
  currentMeetingSymlinkPath?: string
  injectionsPath: string
  updatesPath: string
  assistantResponsesPath: string
  candidateEventsPath: string
  retrievalRequestsPath: string
  liveDocumentPath: string
  liveAstraPath: string
  liveAstraAnalysisId: string
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
  lastBriefPromotionAt?: number
  lastBriefPromotionFiberId?: string
  lastBriefPromotionAstraAnalysisId?: string
  lastLiveAstraSyncAt?: number
  lastError?: string
}

export interface MeetingBridgeState {
  activeMeeting: MeetingRunState | null
  lastMeeting: MeetingRunState | null
}
