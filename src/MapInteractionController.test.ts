import { afterEach, describe, expect, it, vi } from 'vitest'
import { MapInteractionController } from './MapInteractionController'
import type { City, HexCoord, Session } from './state/types'
import type { ContextMenu, MenuItem } from './ui/ContextMenu'

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

function makeController(overrides: Partial<ConstructorParameters<typeof MapInteractionController>[0]> = {}) {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const contextMenu = {
    show: vi.fn(),
  } as unknown as ContextMenu
  const activateRemoteCity = vi.fn()
  const options: ConstructorParameters<typeof MapInteractionController>[0] = {
    canvas,
    camera: {
      dragging: false,
      screenToWorld: vi.fn().mockReturnValue({ x: 0, z: 0 }),
      focusAndZoom: vi.fn(),
    } as unknown as ConstructorParameters<typeof MapInteractionController>[0]['camera'],
    hexGrid: {
      cartesianToHex: vi.fn().mockReturnValue({ q: 0, r: 0 }),
      distance: vi.fn().mockReturnValue(0),
    } as unknown as ConstructorParameters<typeof MapInteractionController>[0]['hexGrid'],
    zoneRenderer: {
      isDraggingSwarm: false,
      getWorkerAtWorldPos: vi.fn().mockReturnValue(null),
      getCityAtWorldPos: vi.fn().mockReturnValue({ entityId: 'remote-city' }),
      getEntityAtHex: vi.fn().mockReturnValue(null),
      startSwarmDrag: vi.fn().mockReturnValue(false),
      clearWorkerFileHover: vi.fn(),
      updateWorkerFileHover: vi.fn(),
      getSwarmWorldPosition: vi.fn().mockReturnValue(null),
    } as unknown as ConstructorParameters<typeof MapInteractionController>[0]['zoneRenderer'],
    contextMenu,
    getCities: () => [city()],
    getSessions: () => [] as Session[],
    getMovingCityId: () => null,
    setMovingCityId: vi.fn(),
    setSelectedHex: vi.fn(),
    handleCityClick: vi.fn(),
    handleDeepCityPress: vi.fn(),
    promptNewWorker: vi.fn(),
    promptAddCity: vi.fn(),
    activateRemoteCity,
    unpinCity: vi.fn(),
    focusKittyTab: vi.fn(),
    killWorker: vi.fn(),
    moveCity: vi.fn(),
    findNearestCity: vi.fn().mockReturnValue(null) as unknown as (hex: HexCoord) => City | null,
    ...overrides,
  }

  return {
    canvas,
    contextMenu,
    activateRemoteCity,
    controller: new MapInteractionController(options),
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('MapInteractionController remote activation menu', () => {
  it('offers Rust-default, one-shot, and Node fallback activation commands for remote cities', () => {
    const { canvas, contextMenu, activateRemoteCity, controller } = makeController()

    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 10,
      clientY: 12,
    }))

    const items = (contextMenu.show as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as MenuItem[]
    expect(items.map((item) => item.label)).toContain('Activate Rust Agent')
    expect(items.map((item) => item.label)).toContain('Activate Rust Once')
    expect(items.map((item) => item.label)).toContain('Activate Node Fallback')
    expect(items.map((item) => item.label)).not.toContain('Activate Rust Preview')

    items.find((item) => item.label === 'Activate Rust Agent')?.action()
    expect(activateRemoteCity).toHaveBeenCalledWith(city())

    items.find((item) => item.label === 'Activate Rust Once')?.action()
    expect(activateRemoteCity).toHaveBeenCalledWith(city(), { agentRuntime: 'rust', once: true })

    items.find((item) => item.label === 'Activate Node Fallback')?.action()
    expect(activateRemoteCity).toHaveBeenCalledWith(city(), { agentRuntime: 'node' })

    controller.dispose()
  })

  it('keeps local city menus focused on local actions', () => {
    const { canvas, contextMenu, controller } = makeController({
      getCities: () => [city({ originId: 'local' })],
    })

    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 10,
      clientY: 12,
    }))

    const items = (contextMenu.show as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as MenuItem[]
    expect(items.map((item) => item.label)).not.toContain('Activate Rust Agent')
    expect(items.map((item) => item.label)).not.toContain('Activate Rust Once')
    expect(items.map((item) => item.label)).not.toContain('Activate Node Fallback')

    controller.dispose()
  })
})
