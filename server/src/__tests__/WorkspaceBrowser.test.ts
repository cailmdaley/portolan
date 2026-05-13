import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
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
  let originManager: OriginManager
  let browser: WorkspaceBrowser
  let cityId: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'portolan-search-'))
    mkdirSync(join(rootDir, 'reports'), { recursive: true })
    writeFileSync(join(rootDir, 'reports', 'summary.txt'), 'summary', 'utf-8')

    cityManager = new CityManager()
    originManager = new OriginManager()
    const city = cityManager.pinCity(rootDir, { q: 0, r: 0 }, 'local', 'TestCity')
    cityId = city.id
    browser = new WorkspaceBrowser(cityManager, originManager, new CityPersistence())
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

  it('uses remote agent directory listing when configured', async () => {
    const remoteOrigin = 'remote-test'
    const remoteCity = cityManager.pinCity(rootDir, { q: 1, r: 1 }, `remote-${remoteOrigin}`, 'RemoteCity')
    const origin = originManager.registerAgent(remoteOrigin, {} as any)
    const directoryCalls: Array<{ originId: string; path: string }> = []

    const remoteBrowser = new WorkspaceBrowser(cityManager, originManager, new CityPersistence(), async (originId, path) => {
      directoryCalls.push({ originId, path })
      return [{ name: 'remote-entry', type: 'file' }]
    })

    const message = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('directory listing timed out')), 5000)
      const ws = {
        readyState: 1,
        send: (payload: string) => {
          const message = JSON.parse(payload)
          if (message.type === 'directoryListing') {
            clearTimeout(timeout)
            resolve(message)
          }
        },
      } as any

      remoteBrowser.handleListDirectory(ws, remoteCity.id, rootDir)
    })

    expect(message).toMatchObject({
      type: 'directoryListing',
      cityId: remoteCity.id,
      path: rootDir,
      entries: [{ name: 'remote-entry', type: 'file' }],
    })
    expect(directoryCalls).toEqual([{ originId: origin.id, path: rootDir }])
  })

  it('does not require an SSH host when remote agent directory listing succeeds', async () => {
    const remoteCity = cityManager.pinCity(rootDir, { q: 1, r: 1 }, 'remote-no-ssh', 'RemoteCity')
    const origin = originManager.registerAgent('no-ssh', {} as any)
    delete origin.sshHost
    const remoteBrowser = new WorkspaceBrowser(cityManager, originManager, new CityPersistence(), async (originId, path) => {
      expect(originId).toBe(origin.id)
      expect(path).toBe(rootDir)
      return [{ name: 'agent-only-entry', type: 'dir' }]
    })

    const message = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('directory listing timed out')), 5000)
      const ws = {
        readyState: 1,
        send: (payload: string) => {
          const message = JSON.parse(payload)
          if (message.type === 'directoryListing') {
            clearTimeout(timeout)
            resolve(message)
          }
        },
      } as any

      remoteBrowser.handleListDirectory(ws, remoteCity.id, rootDir)
    })

    expect(message).toMatchObject({
      type: 'directoryListing',
      cityId: remoteCity.id,
      path: rootDir,
      entries: [{ name: 'agent-only-entry', type: 'dir' }],
    })
  })

  it('falls back to SSH listing when remote list fails', async () => {
    const remoteOrigin = 'remote-test'
    const remoteCity = cityManager.pinCity(rootDir, { q: 1, r: 1 }, `remote-${remoteOrigin}`, 'RemoteCity')
    const origin = originManager.registerAgent(remoteOrigin, {} as any)
    const directoryCalls: Array<{ originId: string; path: string }> = []
    const browserWithFailure = new WorkspaceBrowser(cityManager, originManager, new CityPersistence(), async (originId, path) => {
      directoryCalls.push({ originId, path })
      throw new Error('agent failed')
    })
    const listRemoteSpy = vi
      .spyOn<any, any>(browserWithFailure as any, 'listRemoteDirectory')
      .mockResolvedValue([{ name: 'ssh-entry', type: 'file' }])

    const message = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('directory listing timed out')), 5000)
      const ws = {
        readyState: 1,
        send: (payload: string) => {
          const message = JSON.parse(payload)
          if (message.type === 'directoryListing') {
            clearTimeout(timeout)
            resolve(message)
          }
        },
      } as any

      browserWithFailure.handleListDirectory(ws, remoteCity.id, rootDir)
    })

    expect(message).toMatchObject({
      type: 'directoryListing',
      cityId: remoteCity.id,
      path: rootDir,
      entries: [{ name: 'ssh-entry', type: 'file' }],
    })
    expect(directoryCalls).toEqual([{ originId: origin.id, path: rootDir }])

    expect(listRemoteSpy).toHaveBeenCalled()
  })
})
