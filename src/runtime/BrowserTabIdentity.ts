import { citySpritePathCandidates } from './citySpritePaths'
export { defaultCitySpriteIndex } from './citySpritePaths'

export interface BrowserTabCity {
  id: string
  name: string
}

export type BrowserTabMode = 'narrative' | 'kanban' | 'find' | 'delta'

export interface BrowserTabIdentityState {
  city?: BrowserTabCity | null
  mode?: BrowserTabMode | null
  isOpen?: boolean
  filePath?: string | null
  fiberSlug?: string | null
}

export const DEFAULT_BROWSER_TITLE = 'Portolan'
export const DEFAULT_FAVICON_HREF = '/favicon.svg'

export function buildBrowserTabTitle(state: BrowserTabIdentityState): string {
  if (!state.isOpen) return DEFAULT_BROWSER_TITLE

  const cityName = state.city?.name ?? null
  const scope = cityName ?? 'All cities'
  const resource =
    state.mode === 'narrative'
      ? state.filePath
        ? basename(state.filePath)
        : state.fiberSlug
          ? fiberLabel(state.fiberSlug)
          : null
      : null

  if (resource) return [resource, scope, DEFAULT_BROWSER_TITLE].join(' · ')
  if (state.mode) return [modeLabel(state.mode), scope, DEFAULT_BROWSER_TITLE].join(' · ')
  return DEFAULT_BROWSER_TITLE
}

export function citySpriteIconCandidates(city: BrowserTabCity | null | undefined): string[] {
  if (!city) return [DEFAULT_FAVICON_HREF]
  return citySpritePathCandidates(city)
}

export function isImageContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().split(';', 1)[0].trim().startsWith('image/') ?? false
}

function modeLabel(mode: BrowserTabMode): string {
  if (mode === 'kanban') return 'Kanban'
  if (mode === 'find') return 'Find'
  if (mode === 'delta') return 'Delta'
  return 'Index'
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

function fiberLabel(slug: string): string {
  return slug.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || slug
}
