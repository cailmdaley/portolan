import type { City, HexCoord, Session } from './types'
import type { HexGrid } from '../render/HexGrid'

export function findNearestCity(cities: City[], hexGrid: HexGrid, hex: HexCoord): City | null {
  if (cities.length === 0) return null

  let nearest: City | null = null
  let minDist = Infinity
  for (const city of cities) {
    const dist = hexGrid.distance(hex, city.hex)
    if (dist < minDist) {
      minDist = dist
      nearest = city
    }
  }
  return nearest
}

function isPathInCity(filePath: string, cityPath: string): boolean {
  if (filePath === cityPath) return true
  const root = cityPath.endsWith('/') ? cityPath : `${cityPath}/`
  return filePath.startsWith(root)
}

export function findBestMatchingCity(cities: City[], originId: string, filePath: string): City | null {
  let best: City | null = null
  for (const city of cities) {
    if (city.originId !== originId) continue
    if (!isPathInCity(filePath, city.path)) continue
    if (!best || city.path.length > best.path.length) {
      best = city
    }
  }
  return best
}

export function findBestMatchingCityForPath(
  cities: City[],
  filePath: string,
  preferredOriginId?: string,
): City | null {
  const preferred = preferredOriginId
    ? findBestMatchingCity(cities, preferredOriginId, filePath)
    : null
  if (preferred) return preferred

  let best: City | null = null
  for (const city of cities) {
    if (!isPathInCity(filePath, city.path)) continue
    if (!best || city.path.length > best.path.length) {
      best = city
    }
  }
  if (best) return best

  return findRemoteFeltCityForPath(cities, filePath, preferredOriginId)
}

function findRemoteFeltCityForPath(
  cities: City[],
  filePath: string,
  preferredOriginId?: string,
): City | null {
  const feltMatch = filePath.match(/\/\.felt\/(.+)$/)
  if (!feltMatch) return null
  const segments = feltMatch[1].split('/').filter(Boolean)
  if (segments.length === 0) return null

  const candidates = cities
    .filter((city) => city.originId !== 'local')
    .filter((city) => segments.includes(city.name))
  if (candidates.length === 0) return null

  if (preferredOriginId) {
    const preferred = candidates.find((city) => city.originId === preferredOriginId)
    if (preferred) return preferred
  }

  const segmentRank = (city: City) => {
    const idx = segments.indexOf(city.name)
    return idx < 0 ? Number.MAX_SAFE_INTEGER : idx
  }
  return candidates.sort((a, b) =>
    segmentRank(a) - segmentRank(b)
    || b.path.length - a.path.length
    || a.originId.localeCompare(b.originId),
  )[0] ?? null
}

export function getCityWorkers(city: City, sessions: Session[]): { id: string; name: string; tmuxSession: string }[] {
  return sessions
    .filter(session => session.cityId === city.id && session.originId === city.originId)
    .map(session => ({ id: session.id, name: session.name, tmuxSession: session.tmuxSession }))
}
