import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZoneRendererWorkerTooltip } from './ZoneRendererWorkerTooltip'
import type { Session } from '../state/types'

const filePath = '/Users/cd280747/Documents/projects/portolan/src/main.ts'

function session(): Session {
  return {
    id: 'session-1',
    name: 'session-1',
    tmuxSession: 'portolan-dev',
    cityId: 'portolan',
    hex: { q: 0, r: 0 },
    status: 'idle',
    originId: 'local',
    lastActivity: 1,
  }
}

async function renderTooltip(tooltip: ZoneRendererWorkerTooltip): Promise<HTMLButtonElement> {
  tooltip.updateHover(session(), { x: 100, y: 120 })
  await vi.advanceTimersByTimeAsync(300)
  const item = document.querySelector<HTMLButtonElement>('.worker-file-tooltip-item')
  expect(item).toBeTruthy()
  return item!
}

describe('ZoneRendererWorkerTooltip file actions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        files: [{
          toolName: 'Read',
          fullPath: filePath,
          basename: 'main.ts',
          timestamp: 1,
        }],
      }),
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('marks command-click as a new-tab file open', async () => {
    const tooltip = new ZoneRendererWorkerTooltip()
    const onOpen = vi.fn()
    tooltip.setWorkerFileClickHandler(onOpen)

    const item = await renderTooltip(tooltip)
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))

    expect(onOpen).toHaveBeenCalledWith(filePath, 'local', 'session-1', { openInNewTab: true })
    tooltip.dispose()
  })

  it('routes right-click through the file context menu handler', async () => {
    const tooltip = new ZoneRendererWorkerTooltip()
    const onContextMenu = vi.fn()
    tooltip.setWorkerFileContextMenuHandler(onContextMenu)

    const item = await renderTooltip(tooltip)
    item.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 25,
      clientY: 30,
    }))

    expect(onContextMenu).toHaveBeenCalledWith(filePath, 'local', 'session-1', 25, 30)
    tooltip.dispose()
  })
})
