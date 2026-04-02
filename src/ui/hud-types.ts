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
  metadataPath: string
  bootstrapSentAt?: number
  chunkCount: number
  injectedCount: number
  lastChunkAt?: number
  lastChunkPreview?: string
  lastError?: string
}

export interface MeetingBridgeState {
  activeMeeting: MeetingRunState | null
  lastMeeting: MeetingRunState | null
}
