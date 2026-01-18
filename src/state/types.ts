// Types for hexarchy-v2

export interface HexCoord {
  q: number
  r: number
}

export interface CartesianCoord {
  x: number
  z: number
}

// Server types (raw from WebSocket)
export interface ServerCity {
  id: string
  name: string
  path: string
  position: HexCoord
  fiberCount?: number
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
}

export interface Session {
  id: string
  name: string
  cityId: string | null
  hex: HexCoord | null
  status: 'idle' | 'working' | 'attention'
}

// Transform server city to frontend city
export function normalizeCity(city: ServerCity): City {
  return {
    id: city.id,
    name: city.name,
    path: city.path,
    hex: city.position,
    fiberCount: city.fiberCount ?? 0,
  }
}

// Transform server session to frontend session
export function normalizeSession(session: ServerSession): Session {
  return {
    id: session.id,
    name: session.name,
    cityId: session.cityId ?? null,
    hex: session.workerHex ?? null,
    // Map 'offline' to 'idle' for rendering (offline sessions shouldn't appear anyway)
    status: session.status === 'offline' ? 'idle' : session.status,
  }
}

// Cartographic Warmth palette
export const PALETTE = {
  sand: 0xe8dcc4,      // Background, idle hexes
  ochre: 0xc4956a,     // City hexes
  terracotta: 0xb87333, // Warm accents
  verdigris: 0x4a7c6f, // Working state
  lapis: 0x5b7c99,     // Cool accents
  umber: 0x6b5344,     // Labels, borders
  sepia: 0x8b7355,     // Dormant state
  vermillion: 0xc54b3d, // Attention — vivid
} as const

export const PALETTE_CSS = {
  sand: '#E8DCC4',
  ochre: '#C4956A',
  terracotta: '#B87333',
  verdigris: '#4A7C6F',
  lapis: '#5B7C99',
  umber: '#6B5344',
  sepia: '#8B7355',
  vermillion: '#C54B3D',
} as const
