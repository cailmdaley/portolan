export interface CitySpriteIdentity {
  id: string
  name: string
}

export const NUM_DEFAULT_CITY_SPRITES = 5

export function customCitySpritePath(city: CitySpriteIdentity): string {
  return `/sprites/cities/${encodeURIComponent(city.name)}.png`
}

export function defaultCitySpritePath(cityId: string): string {
  return defaultCitySpritePathByIndex(defaultCitySpriteIndex(cityId))
}

export function defaultCitySpritePathByIndex(index: number): string {
  return `/sprites/cities/default-${index}.png`
}

export function citySpritePathCandidates(city: CitySpriteIdentity): string[] {
  return [customCitySpritePath(city), defaultCitySpritePath(city.id)]
}

export function defaultCitySpriteIndex(cityId: string): number {
  let hash = 0
  for (let i = 0; i < cityId.length; i++) {
    hash = ((hash << 5) - hash) + cityId.charCodeAt(i)
    hash = hash & hash
  }
  return (Math.abs(hash) % NUM_DEFAULT_CITY_SPRITES) + 1
}
