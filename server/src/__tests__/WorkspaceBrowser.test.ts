import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { CityManager } from '../CityManager.js'
import { OriginManager } from '../OriginManager.js'
import { CityPersistence } from '../CityPersistence.js'
import { WorkspaceBrowser } from '../WorkspaceBrowser.js'

describe('WorkspaceBrowser search', () => {
  let rootDir: string
  let cityManager: CityManager
  let browser: WorkspaceBrowser
  let cityId: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'portolan-search-'))
    mkdirSync(join(rootDir, 'reports'), { recursive: true })
    writeFileSync(join(rootDir, 'reports', 'summary.txt'), 'summary', 'utf-8')

    cityManager = new CityManager()
    const city = cityManager.pinCity(rootDir, { q: 0, r: 0 }, 'local', 'TestCity')
    cityId = city.id
    browser = new WorkspaceBrowser(cityManager, new OriginManager(), new CityPersistence())
  })

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('returns directory hits for filename search queries', async () => {
    const results = await new Promise<any[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('search timed out')), 5000)
      const ws = {
        readyState: 1,
        send: (payload: string) => {
          const message = JSON.parse(payload)
          if (message.type === 'searchResults') {
            clearTimeout(timeout)
            resolve(message.results)
          }
        },
      } as any

      browser.handleSearchFiles(ws, cityId, 'reports', 'search-1', 'filename')
    })

    expect(results.some((result) => result.type === 'dir' && result.fullPath === join(rootDir, 'reports'))).toBe(true)
  })
})
