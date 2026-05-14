import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { City } from '../state/types'

// Pending loader callbacks per request, keyed by URL path. Each fake load
// stashes { resolve, reject } into this map so individual tests can simulate
// success/failure ordering between default sprites and custom sprites — the
// race we're testing is purely about that ordering.
type LoaderCallbacks = { resolve: () => void; reject: () => void }
const pendingByUrl = new Map<string, LoaderCallbacks[]>()

vi.mock('three', () => {
  class FakeTexture {
    userData: Record<string, unknown> = {}
    dispose = vi.fn()
  }
  class FakeTextureLoader {
    load(
      url: string,
      onLoad: (texture: FakeTexture) => void,
      _progress: undefined,
      onError: () => void,
    ) {
      const callbacks: LoaderCallbacks = {
        resolve: () => onLoad(new FakeTexture()),
        reject: () => onError(),
      }
      const queue = pendingByUrl.get(url) ?? []
      queue.push(callbacks)
      pendingByUrl.set(url, queue)
    }
  }
  return { Texture: FakeTexture, TextureLoader: FakeTextureLoader }
})

// Import after the mock so the manager picks up our fake three.
import { CitySpritesManager } from './CitySpritesManager'
import { defaultCitySpriteIndex } from '../runtime/citySpritePaths'

function drain(url: string, mode: 'resolve' | 'reject'): void {
  const queue = pendingByUrl.get(url)
  if (!queue) throw new Error(`no pending load for ${url}`)
  for (const { resolve, reject } of queue) (mode === 'resolve' ? resolve : reject)()
  pendingByUrl.delete(url)
}

function city(id: string, name: string): City {
  return {
    id,
    name,
    hex: { q: 0, r: 0 },
    originId: 'local',
    cwd: `/tmp/${name}`,
  } as City
}

describe('CitySpritesManager fallback behavior', () => {
  beforeEach(() => {
    pendingByUrl.clear()
  })

  afterEach(() => {
    pendingByUrl.clear()
  })

  it('fires the sprite-loaded callback when a custom sprite 404s so the renderer can swap to the default', () => {
    const manager = new CitySpritesManager()
    const onLoaded = vi.fn()
    manager.onSpriteLoaded(onLoaded)

    // Defaults arrive synchronously (resolved before the custom load fails).
    for (let i = 1; i <= 5; i++) drain(`/sprites/cities/default-${i}.png`, 'resolve')

    const c = city('city-no-custom', 'no-custom')
    expect(manager.getSprite(c)).toBeTruthy() // returns a default while loading
    drain('/sprites/cities/no-custom.png', 'reject')

    // Before the fix, the failure handler silently set failedLoads and the
    // city stayed rendered as a raw hex tile forever. The callback is the
    // signal that lets the renderer re-render and pick up the default.
    expect(onLoaded).toHaveBeenCalledWith('city-no-custom')
  })

  it('re-renders cities that asked for a default before defaults finished loading', () => {
    const manager = new CitySpritesManager()
    const onLoaded = vi.fn()
    manager.onSpriteLoaded(onLoaded)

    // Defaults are still in flight. The first render for this city resolves
    // to null — the renderer falls through to the raw-hex branch.
    const c = city('city-early', 'early')
    expect(manager.getSprite(c)).toBeNull()

    // Custom sprite 404s while defaults are still loading. Callback fires,
    // but the renderer's re-render would *also* get null at this point.
    drain('/sprites/cities/early.png', 'reject')
    expect(onLoaded).toHaveBeenCalledWith('city-early')
    onLoaded.mockClear()

    // Now defaults arrive. The pending-default machinery must fire the
    // callback again so the renderer re-renders and this time gets a
    // real default texture.
    for (let i = 1; i <= 5; i++) drain(`/sprites/cities/default-${i}.png`, 'resolve')

    expect(onLoaded).toHaveBeenCalledWith('city-early')
    expect(manager.getSprite(c)).not.toBeNull()
  })

  it('returns the deterministic default once defaults have loaded', () => {
    const manager = new CitySpritesManager()
    for (let i = 1; i <= 5; i++) drain(`/sprites/cities/default-${i}.png`, 'resolve')

    const c = city('stable-city-id', 'whatever')
    const idx = defaultCitySpriteIndex('stable-city-id')
    expect(manager.getDefaultSprite('stable-city-id')).toBeTruthy()
    expect(idx).toBeGreaterThanOrEqual(1)
    expect(idx).toBeLessThanOrEqual(5)
    // getSprite while a custom load is in flight uses the default too.
    expect(manager.getSprite(c)).toBeTruthy()
  })
})
