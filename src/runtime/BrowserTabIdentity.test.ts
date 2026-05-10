import { describe, expect, it } from 'vitest'
import {
  buildBrowserTabTitle,
  citySpriteIconCandidates,
  defaultCitySpriteIndex,
} from './BrowserTabIdentity'

describe('BrowserTabIdentity', () => {
  it('uses the focused city when no vellum surface is open', () => {
    expect(buildBrowserTabTitle({
      city: { id: 'portolan', name: 'portolan' },
      isOpen: false,
    })).toBe('portolan · Portolan')
  })

  it('puts the active filename first so narrow browser tabs differ', () => {
    expect(buildBrowserTabTitle({
      city: { id: 'portolan', name: 'portolan' },
      isOpen: true,
      mode: 'narrative',
      filePath: '/Users/cd280747/Documents/projects/portolan/src/main.ts',
    })).toBe('main.ts · portolan · Portolan')
  })

  it('names global tab surfaces without a focused city', () => {
    expect(buildBrowserTabTitle({
      isOpen: true,
      mode: 'find',
    })).toBe('Find · All cities · Portolan')
  })

  it('uses custom city sprites first, then the deterministic map fallback', () => {
    const candidates = citySpriteIconCandidates({ id: 'ai-futures', name: 'ai-futures' })
    expect(candidates).toEqual([
      '/sprites/cities/ai-futures.png',
      `/sprites/cities/default-${defaultCitySpriteIndex('ai-futures')}.png`,
    ])
  })
})
