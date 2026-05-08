import { describe, expect, it } from 'vitest'
import { findBestMatchingCityForPath } from './cityLookup'
import type { City } from './types'

function city(overrides: Partial<City>): City {
  return {
    id: 'city',
    name: 'city',
    path: '/tmp/city',
    hex: { q: 0, r: 0 },
    fiberCount: 0,
    hasClaims: false,
    hasPlaygrounds: false,
    isDormant: false,
    originId: 'local',
    ...overrides,
  }
}

describe('findBestMatchingCityForPath', () => {
  it('repairs stale remote file-mode URL state by choosing the local owning city', () => {
    const localLightcone = city({
      id: 'lightcone-research',
      name: 'LightconeResearch',
      path: '/Users/cd280747/Documents/projects/LightconeResearch',
      originId: 'local',
    })
    const staleRemoteFocus = city({
      id: 'pure-eb',
      name: 'pure_eb',
      path: '/automnt/n17data/cdaley/unions/pure_eb',
      originId: 'remote-candide',
    })

    const owner = findBestMatchingCityForPath(
      [staleRemoteFocus, localLightcone],
      '/Users/cd280747/Documents/projects/LightconeResearch/lightcone-cli/claude/lightcone/skills/lc-new/SKILL.md',
      staleRemoteFocus.originId,
    )

    expect(owner).toBe(localLightcone)
  })

  it('uses the most specific matching city when several local roots contain the path', () => {
    const parent = city({
      id: 'lightcone-research',
      path: '/Users/cd280747/Documents/projects/LightconeResearch',
      originId: 'local',
    })
    const child = city({
      id: 'lightcone-cli',
      path: '/Users/cd280747/Documents/projects/LightconeResearch/lightcone-cli',
      originId: 'local',
    })

    const owner = findBestMatchingCityForPath(
      [parent, child],
      '/Users/cd280747/Documents/projects/LightconeResearch/lightcone-cli/claude/lightcone/skills/lc-new/SKILL.md',
      'local',
    )

    expect(owner).toBe(child)
  })

  it('does not treat sibling paths with a shared prefix as containing the file', () => {
    const siblingPrefix = city({
      id: 'lightcone',
      path: '/Users/cd280747/Documents/projects/Lightcone',
      originId: 'local',
    })
    const owner = city({
      id: 'lightcone-research',
      path: '/Users/cd280747/Documents/projects/LightconeResearch',
      originId: 'local',
    })

    const match = findBestMatchingCityForPath(
      [siblingPrefix, owner],
      '/Users/cd280747/Documents/projects/LightconeResearch/lightcone-cli/claude/lightcone/skills/lc-new/SKILL.md',
      'local',
    )

    expect(match).toBe(owner)
  })
})
