import { describe, expect, it } from 'vitest'
import { readUrlState } from './UrlFragment'
import { buildVellumFileUrl } from './vellumFileLink'

describe('buildVellumFileUrl', () => {
  it('builds a clean deep link that opens vellum file mode in a new tab', () => {
    const url = buildVellumFileUrl({
      baseUrl: 'http://localhost:5173/?vellumDebug=/old.md#city=stale',
      cityId: 'lightcone-research',
      path: '/Users/cd280747/Documents/projects/LightconeResearch/lightcone-cli/claude/lightcone/skills/lc-new/SKILL.md',
    })

    expect(url).toBe(
      'http://localhost:5173/#city=lightcone-research&mode=narrative&file=%2FUsers%2Fcd280747%2FDocuments%2Fprojects%2FLightconeResearch%2Flightcone-cli%2Fclaude%2Flightcone%2Fskills%2Flc-new%2FSKILL.md',
    )
  })

  it('round-trips through the URL state parser', () => {
    const url = buildVellumFileUrl({
      baseUrl: window.location.href,
      cityId: 'portolan',
      path: '/Users/cd280747/Documents/projects/portolan/src/main.ts',
    })

    window.history.replaceState(null, '', url)

    expect(readUrlState()).toEqual({
      cityId: 'portolan',
      mode: 'narrative',
      fiberSlug: undefined,
      filePath: '/Users/cd280747/Documents/projects/portolan/src/main.ts',
      scopeCityId: undefined,
    })
  })
})
