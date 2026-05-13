import { describe, expect, it } from 'vitest'
import { readUrlState } from './UrlFragment'
import { buildVellumFiberUrl, buildVellumFileUrl } from './vellumFileLink'

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
      originId: undefined,
      scopeCityId: undefined,
    })
  })

  it('carries remote origin in file-mode deep links', () => {
    const url = buildVellumFileUrl({
      baseUrl: 'http://localhost:5173/',
      cityId: 'pure-eb',
      originId: 'remote-candide',
      path: '/home/cdaley/loom/.felt/science/pure_eb/review.md',
    })

    expect(url).toBe(
      'http://localhost:5173/#city=pure-eb&mode=narrative&file=%2Fhome%2Fcdaley%2Floom%2F.felt%2Fscience%2Fpure_eb%2Freview.md&origin=remote-candide',
    )
  })
})

describe('buildVellumFiberUrl', () => {
  it('builds a narrative deep link for a city-scoped fiber', () => {
    const url = buildVellumFiberUrl({
      baseUrl: 'http://localhost:5173/?stale=1#city=old',
      cityId: 'portolan',
      slug: 'portolan/constitution-native-desktop-portolan',
    })

    expect(url).toBe(
      'http://localhost:5173/#city=portolan&mode=narrative&fiber=portolan%2Fconstitution-native-desktop-portolan',
    )
  })

  it('round-trips through the URL state parser', () => {
    const url = buildVellumFiberUrl({
      baseUrl: window.location.href,
      cityId: 'portolan',
      slug: 'portolan/constitution-native-desktop-portolan',
    })

    window.history.replaceState(null, '', url)

    expect(readUrlState()).toEqual({
      cityId: 'portolan',
      mode: 'narrative',
      fiberSlug: 'portolan/constitution-native-desktop-portolan',
      filePath: undefined,
      originId: undefined,
      scopeCityId: undefined,
    })
  })
})
