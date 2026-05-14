import { describe, expect, it } from 'vitest'
import {
  buildBrowserTabTitle,
  citySpriteIconCandidates,
  defaultCitySpriteIndex,
  isImageContentType,
} from './BrowserTabIdentity'

describe('BrowserTabIdentity', () => {
  it('keeps idle map tabs at the product title', () => {
    expect(buildBrowserTabTitle({
      city: { id: 'portolan', name: 'portolan' },
      isOpen: false,
    })).toBe('Portolan')
  })

  it('puts the active filename first so narrow browser tabs differ', () => {
    expect(buildBrowserTabTitle({
      city: { id: 'portolan', name: 'portolan' },
      isOpen: true,
      mode: 'narrative',
      filePath: '/Users/cd280747/Documents/projects/portolan/src/main.ts',
    })).toBe('main.ts · portolan · Portolan')
  })

  it('uses the fiber leaf for narrative fibers', () => {
    expect(buildBrowserTabTitle({
      city: { id: 'portolan', name: 'portolan' },
      isOpen: true,
      mode: 'narrative',
      fiberSlug: 'constitution-native-desktop-portolan/finding-native-window-title-sync',
    })).toBe('finding-native-window-title-sync · portolan · Portolan')
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

  it('accepts only image content types for custom sprite candidates', () => {
    expect(isImageContentType('image/png')).toBe(true)
    expect(isImageContentType('image/svg+xml; charset=utf-8')).toBe(true)
    expect(isImageContentType('text/html')).toBe(false)
    expect(isImageContentType(null)).toBe(false)
  })
})
