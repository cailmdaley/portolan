// Shared types for CityHUD

export interface Fiber {
  id: string
  name: string
  status: string
  kind: string
  priority: number
  createdAt: string
  body?: string
  outcome?: string
  reason?: string
  tags?: string[]
  parentId?: string | null
  isRoot?: boolean
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

