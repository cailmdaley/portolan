// Types for hexarchy-v2

export interface HexCoord {
  q: number
  r: number
}

export interface CartesianCoord {
  x: number
  z: number
}

// Recent file (mtime-based)
export interface RecentFile {
  path: string        // Relative path from city root
  fullPath: string    // Full path for opening
  mtime: number       // Modification time (epoch ms)
}

// Worker activity event
export interface Activity {
  tool: string
  summary?: string
  fullPath?: string   // Full file path for Read/Write/Edit
  timestamp: number
}

// Git status for a repository
export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  staged: { added: number; modified: number; deleted: number }
  unstaged: { added: number; modified: number; deleted: number }
  untracked: number
  totalFiles: number
  linesAdded: number
  linesRemoved: number
  lastCommitTime: number | null
  lastCommitMessage: string | null
  isRepo: boolean
  lastChecked: number
}

// Server types (raw from WebSocket)
export interface ServerCity {
  id: string
  name: string
  path: string
  position: HexCoord
  fiberCount?: number
  hasClaims?: boolean  // Has claims directory (workflow/config or results/claims)
  isDormant?: boolean  // No active sessions (persisted city with no workers)
  gitStatus?: GitStatus  // Git repository status
  recentFiles?: RecentFile[]  // Recently modified files
  originId: string  // 'local' | 'remote-{hostname}'
}

export interface ServerSession {
  id: string
  name: string
  tmuxSession: string
  cwd: string
  cityId?: string | null
  workerHex?: HexCoord
  status: 'idle' | 'working' | 'offline'
  createdAt: number
  lastActivity: number
  originId: string  // 'local' | 'remote-{hostname}'
}

export interface ServerOrigin {
  id: string
  name: string
  type: 'local' | 'remote'
  sshHost?: string
  plannotatorPort?: number
  position: HexCoord
  connectedAt: number
  lastSeen: number
}

// Frontend types (normalized for rendering)
export interface City {
  id: string
  name: string
  path: string
  hex: HexCoord
  fiberCount: number
  hasClaims: boolean
  isDormant: boolean
  gitStatus?: GitStatus
  recentFiles?: RecentFile[]
  originId: string
}

export interface Session {
  id: string
  name: string
  tmuxSession: string
  cityId: string | null
  hex: HexCoord | null
  status: 'idle' | 'working'
  originId: string  // 'local' | 'remote-{hostname}'
}

// Transform server city to frontend city
export function normalizeCity(city: ServerCity): City {
  return {
    id: city.id,
    name: city.name,
    path: city.path,
    hex: city.position,
    fiberCount: city.fiberCount ?? 0,
    hasClaims: city.hasClaims ?? false,
    isDormant: city.isDormant ?? false,
    gitStatus: city.gitStatus,
    recentFiles: city.recentFiles,
    originId: city.originId,
  }
}

// Transform server session to frontend session
export function normalizeSession(session: ServerSession): Session {
  return {
    id: session.id,
    name: session.name,
    tmuxSession: session.tmuxSession,
    cityId: session.cityId ?? null,
    hex: session.workerHex ?? null,
    // Map 'offline' to 'idle' for rendering (offline sessions shouldn't appear anyway)
    status: session.status === 'offline' ? 'idle' : session.status,
    originId: session.originId,
  }
}

// Porch Morning palette
export const PALETTE = {
  // Backgrounds
  bgPrimary: 0xc8b8a8,     // Main background, ground plane
  bgCard: 0xede8e0,        // Panels
  bgElevated: 0xfdfcfa,    // Elevated elements

  // Text
  textPrimary: 0x2e2a26,
  textSecondary: 0x4a4540,
  textMuted: 0x7a7368,

  // Borders
  border: 0xa89888,
  borderLight: 0xc8bba8,

  // Semantic
  accent: 0x5a7b7b,        // Teal — working state
  gold: 0x9a7b35,          // City hexes
  goldLight: 0xc4a86a,     // City highlights
  green: 0x6b8b6b,         // Success states
  red: 0xa87070,           // Attention state

  // Hex-specific
  cityHex: 0x9a7b35,       // Gold — cities
  cityDormant: 0x8a8070,   // Muted gold — dormant cities (no workers)
  workerIdle: 0x7a7368,    // Muted — dormant workers
  workerActive: 0x5a7b7b,  // Teal — working
  // workerAttention removed - attention status was speculative
  emptyHex: 0xc8b8a8,      // Background terrain
  selection: 0xc4a86a,     // Gold highlight ring
} as const

export const PALETTE_CSS = {
  bgPrimary: '#C8B8A8',
  bgCard: '#EDE8E0',
  bgElevated: '#FDFCFA',
  textPrimary: '#2E2A26',
  textSecondary: '#4A4540',
  textMuted: '#7A7368',
  border: '#A89888',
  borderLight: '#C8BBA8',
  accent: '#5A7B7B',
  gold: '#9A7B35',
  goldLight: '#C4A86A',
  green: '#6B8B6B',
  red: '#A87070',
} as const
