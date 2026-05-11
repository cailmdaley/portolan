import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalSearchPalette } from './GlobalSearchPalette'
import type { City, Session } from '../state/types'

function city(overrides: Partial<City>): City {
  return {
    id: 'city-1',
    name: 'portolan',
    path: '/tmp/portolan',
    hex: { q: 0, r: 0 },
    fiberCount: 0,
    hasClaims: false,
    hasPlaygrounds: false,
    isDormant: false,
    originId: 'local',
    ...overrides,
  }
}

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    name: 'portolan-d...',
    tmuxSession: 'portolan-dev',
    cityId: 'portolan',
    hex: { q: 0, r: 0 },
    status: 'idle',
    originId: 'local',
    lastActivity: 1,
    ...overrides,
  }
}

afterEach(() => {
  document.body.replaceChildren()
  document.head.querySelector('#gs-palette-styles')?.remove()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  vi.restoreAllMocks()
})

describe('GlobalSearchPalette', () => {
  it('renders city/worker map results and selects workers by full tmux name', () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const onSelectCity = vi.fn()
    const onSelectWorker = vi.fn()
    const palette = new GlobalSearchPalette({ onSelectCity, onSelectWorker })

    const localAiFutures = city({
      id: 'ai-local',
      name: 'ai-futures',
      path: '/tmp/ai-futures',
      originId: 'local',
    })
    const remoteAiFutures = city({
      id: 'ai-remote',
      name: 'ai-futures',
      path: '/remote/ai-futures',
      originId: 'remote-candide',
    })
    const worker = session({
      id: 'worker-1',
      name: 'portolan-d...',
      tmuxSession: 'portolan-dev',
      cityId: 'ai-local',
    })

    palette.show([remoteAiFutures, localAiFutures], [worker])

    expect(document.querySelector<HTMLInputElement>('.gs-input')?.getAttribute('aria-label'))
      .toBe('Search cities and workers')
    expect(document.querySelector('[aria-label="City ai-futures on candide"]')).toBeTruthy()

    const input = document.querySelector<HTMLInputElement>('.gs-input')
    if (!input) throw new Error('palette input not found')
    input.value = 'portolan-dev'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(onSelectCity).not.toHaveBeenCalled()
    expect(onSelectWorker).toHaveBeenCalledWith(worker)
    expect(palette.isVisible()).toBe(false)
  })
})
