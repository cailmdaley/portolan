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

// Porch Morning palette (hex colors used in Three.js)
export const PALETTE = {
  bgPrimary: 0xc8b8a8,     // Ground plane
  border: 0xa89888,        // Hex borders
  cityHex: 0x9a7b35,       // Gold — active cities
  cityDormant: 0x8a8070,   // Muted — dormant cities
  workerIdle: 0x7a7368,    // Muted — idle workers
  workerActive: 0x5a7b7b,  // Teal — working
  selection: 0xc4a86a,     // Gold highlight ring
} as const

