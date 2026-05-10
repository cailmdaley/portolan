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

const NUM_DEFAULT_CITY_SPRITES = 5

export function buildBrowserTabTitle(state: BrowserTabIdentityState): string {
  const cityName = state.city?.name ?? null
  const scope = cityName ?? 'All cities'
  const resource =
    state.isOpen && state.mode === 'narrative'
      ? state.filePath
        ? basename(state.filePath)
        : state.fiberSlug
          ? fiberLabel(state.fiberSlug)
          : null
      : null

  if (resource) return [resource, scope, DEFAULT_BROWSER_TITLE].join(' · ')
  if (state.isOpen && state.mode) return [modeLabel(state.mode), scope, DEFAULT_BROWSER_TITLE].join(' · ')
  if (cityName) return [cityName, DEFAULT_BROWSER_TITLE].join(' · ')
  return DEFAULT_BROWSER_TITLE
}

export function citySpriteIconCandidates(city: BrowserTabCity | null | undefined): string[] {
  if (!city) return [DEFAULT_FAVICON_HREF]
  return [
    `/sprites/cities/${encodeURIComponent(city.name)}.png`,
    `/sprites/cities/default-${defaultCitySpriteIndex(city.id)}.png`,
  ]
}

export function defaultCitySpriteIndex(cityId: string): number {
  let hash = 0
  for (let i = 0; i < cityId.length; i++) {
    hash = ((hash << 5) - hash) + cityId.charCodeAt(i)
    hash = hash & hash
  }
  return (Math.abs(hash) % NUM_DEFAULT_CITY_SPRITES) + 1
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
