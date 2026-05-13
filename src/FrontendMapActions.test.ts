import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrontendMapActions } from './FrontendMapActions'
import type { City } from './state/types'
import type { NewWorkerDialog } from './ui/NewWorkerDialog'

function city(overrides: Partial<City> = {}): City {
  return {
    id: 'remote-city',
    name: 'pure-eb',
    path: '/remote/pure-eb',
    hex: { q: 0, r: 0 },
    fiberCount: 0,
    hasClaims: false,
    hasPlaygrounds: false,
    isDormant: true,
    originId: 'remote-candide',
    ...overrides,
  }
}

function actions(): FrontendMapActions {
  return new FrontendMapActions({
    newWorkerDialog: { show: vi.fn(), dispose: vi.fn() } as unknown as NewWorkerDialog,
    sendMessage: vi.fn().mockReturnValue(true),
    getWebSocketState: () => 'open',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FrontendMapActions.activateRemoteCity', () => {
  it('posts the Rust preview profile as an activation body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: 'started' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await actions().activateRemoteCity(city(), { agentRuntime: 'rust', once: true })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4004/activate-city', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cityId: 'remote-city',
        agentRuntime: 'rust',
        origin: 'candide',
        once: true,
      }),
    })
  })

  it('preserves Node activation as the default runtime', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: 'started' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await actions().activateRemoteCity(city())

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      cityId: 'remote-city',
      agentRuntime: 'node',
      origin: 'candide',
      once: false,
    })
  })
})
