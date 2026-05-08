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
  return best
}

export function getCityWorkers(city: City, sessions: Session[]): { id: string; name: string; tmuxSession: string }[] {
  return sessions
    .filter(session => session.cityId === city.id && session.originId === city.originId)
    .map(session => ({ id: session.id, name: session.name, tmuxSession: session.tmuxSession }))
}
