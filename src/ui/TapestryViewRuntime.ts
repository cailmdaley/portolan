import type { City } from '../state/types'
import { artifactEntries, isPdfArtifact } from './tapestry-helpers'
import { TapestryStaticFileModal } from './TapestryStaticFileModal'
import type { TapestryResponse } from './tapestry-types'

const API_BASE = `http://${window.location.hostname}:4004`
const PRELOAD_CACHE_LIMIT = 64

export class TapestryViewRuntime {
  private currentCity: City | null = null
  private tapestryData: TapestryResponse | null = null
  private selectedNodeId: string | null = null
  private staticMode = false
  private staticAssetBase = ''
  private staticDataBase = ''
  private preloadCache = new Map<string, HTMLImageElement>()
  private dataFetchAbortController: AbortController | null = null
  private dataRequestId = 0
  private staticFileModal: TapestryStaticFileModal | null = null
  private disposed = false

  getCurrentCity(): City | null {
    return this.currentCity
  }

  getTapestryData(): TapestryResponse | null {
    return this.tapestryData
  }

  getSelectedNodeId(): string | null {
    return this.selectedNodeId
  }

  isStaticMode(): boolean {
    return this.staticMode
  }

  isDisposed(): boolean {
    return this.disposed
  }

  getRuntimeStats(): {
    disposed: boolean
    staticMode: boolean
    currentCityId: string | null
    selectedNodeId: string | null
    preloadCacheSize: number
    hasDataFetchRequest: boolean
    dataRequestId: number
    hasStaticFileModal: boolean
    hasStaticFileModalKeyHandler: boolean
  } {
    return {
      disposed: this.disposed,
      staticMode: this.staticMode,
      currentCityId: this.currentCity?.id ?? null,
      selectedNodeId: this.selectedNodeId,
      preloadCacheSize: this.preloadCache.size,
      hasDataFetchRequest: this.dataFetchAbortController !== null,
      dataRequestId: this.dataRequestId,
      hasStaticFileModal: this.staticFileModal?.isOpen() ?? false,
      hasStaticFileModalKeyHandler: this.staticFileModal?.isOpen() ?? false,
    }
  }

  async showCity(city: City): Promise<TapestryResponse> {
    this.disposed = false
    this.clearPreloadCache()
    this.staticFileModal?.close()
    this.staticFileModal = null

    this.currentCity = city
    this.tapestryData = null
    this.selectedNodeId = null
    this.staticMode = false
    this.staticAssetBase = ''
    this.staticDataBase = ''

    const incomingHash = window.location.hash
    const url = new URL(window.location.href)
    url.searchParams.set('city', city.id)
    url.hash = incomingHash
    window.history.replaceState(null, '', url.toString())

    const { requestId, signal } = this.beginDataRequest()
    try {
      const response = await fetch(`${API_BASE}/tapestry?cityId=${encodeURIComponent(city.id)}`, { signal })
      if (!response.ok) throw new Error(await response.text())
      const data = await response.json()
      if (!this.isCurrentDataRequest(requestId)) throw new DOMException('Stale tapestry request', 'AbortError')
      this.tapestryData = data
      return data
    } finally {
      if (this.isCurrentDataRequest(requestId)) {
        this.dataFetchAbortController = null
      }
    }
  }

  async refresh(): Promise<TapestryResponse | null> {
    if (!this.currentCity) return null

    const { requestId, signal } = this.beginDataRequest()
    try {
      const response = await fetch(`${API_BASE}/tapestry?cityId=${encodeURIComponent(this.currentCity.id)}`, { signal })
      if (!response.ok) throw new Error(await response.text())
      const data = await response.json()
      if (!this.isCurrentDataRequest(requestId)) throw new DOMException('Stale tapestry request', 'AbortError')
      this.tapestryData = data
      return data
    } finally {
      if (this.isCurrentDataRequest(requestId)) {
        this.dataFetchAbortController = null
      }
    }
  }

  showStatic(data: TapestryResponse, assetBase = './data/claims'): void {
    this.disposed = false
    this.clearDataRequest()
    this.clearPreloadCache()
    this.staticFileModal?.close()

    this.currentCity = null
    this.staticMode = true
    this.staticAssetBase = assetBase
    this.staticDataBase = assetBase.replace(/\/[^/]+\/claims$/, '')
    this.staticFileModal = new TapestryStaticFileModal(this.staticDataBase)
    this.tapestryData = data
    this.selectedNodeId = null
  }

  hide(): void {
    this.clearDataRequest()
    this.clearPreloadCache()
    this.staticFileModal?.close()

    const url = new URL(window.location.href)
    url.searchParams.delete('city')
    url.hash = ''
    window.history.replaceState(null, '', url.toString())

    this.currentCity = null
    this.selectedNodeId = null
    this.tapestryData = null
    this.staticMode = false
    this.staticAssetBase = ''
    this.staticDataBase = ''
  }

  dispose(): void {
    this.disposed = true
    this.hide()
  }

  setSelectedNodeId(nodeId: string | null): void {
    this.selectedNodeId = nodeId
  }

  pushHash(id: string | null): void {
    const current = window.location.hash.slice(1)
    if (id === current) return
    if (id) {
      window.history.pushState(null, '', `#${id}`)
      return
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }

  selectFromHash(onSelectNode: (id: string) => void, onSelectFiber: (id: string) => void): void {
    const hash = window.location.hash.slice(1)
    if (!hash || !this.tapestryData) return
    const node = this.tapestryData.nodes.find((candidate) => candidate.id === hash)
    if (node) {
      onSelectNode(hash)
      return
    }
    if (this.tapestryData.fibers?.find((fiber) => fiber.id === hash)) {
      onSelectFiber(hash)
    }
  }

  artifactUrl(specName: string, filePath: string): string {
    const filename = filePath.split('/').pop() || ''
    if (this.staticMode) {
      return `${this.staticAssetBase}/${encodeURIComponent(specName)}/${encodeURIComponent(filename)}`
    }
    return `${API_BASE}/tapestry-asset/${encodeURIComponent(specName)}/${encodeURIComponent(filename)}?cityId=${encodeURIComponent(this.currentCity?.id || '')}`
  }

  preloadNeighborArtifacts(nodeId: string): void {
    if (!this.tapestryData) return
    const node = this.tapestryData.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return

    const neighborIds = new Set<string>()
    node.dependsOn.forEach((id) => neighborIds.add(id))
    const downstream = this.tapestryData.downstream[nodeId] || []
    downstream.forEach((candidate) => neighborIds.add(candidate.id))

    for (const neighborId of neighborIds) {
      const neighbor = this.tapestryData.nodes.find((candidate) => candidate.id === neighborId)
      if (!neighbor?.evidence?.artifacts) continue
      const entries = artifactEntries(neighbor.evidence.artifacts)
      if (entries.length === 0) continue
      const firstImage = entries.find(([, path]) => !isPdfArtifact(path))
      if (!firstImage) continue
      const [, path] = firstImage
      const url = this.artifactUrl(neighbor.specName || '', path)
      if (this.touchPreload(url)) continue
      const img = new Image()
      img.src = url
      this.preloadCache.set(url, img)
      this.prunePreloadCache()
    }
  }

  openStaticFile(href: string, line?: number): void {
    this.staticFileModal?.open(href, line)
  }

  private beginDataRequest(): { requestId: number; signal: AbortSignal } {
    this.dataFetchAbortController?.abort()
    const controller = new AbortController()
    this.dataFetchAbortController = controller
    const requestId = ++this.dataRequestId
    return { requestId, signal: controller.signal }
  }

  private isCurrentDataRequest(requestId: number): boolean {
    return !this.disposed && requestId === this.dataRequestId
  }

  private clearDataRequest(): void {
    this.dataFetchAbortController?.abort()
    this.dataFetchAbortController = null
  }

  private clearPreloadCache(): void {
    for (const img of this.preloadCache.values()) {
      img.onload = null
      img.onerror = null
      img.src = ''
    }
    this.preloadCache.clear()
  }

  private touchPreload(url: string): boolean {
    const existing = this.preloadCache.get(url)
    if (!existing) return false
    this.preloadCache.delete(url)
    this.preloadCache.set(url, existing)
    return true
  }

  private prunePreloadCache(): void {
    while (this.preloadCache.size > PRELOAD_CACHE_LIMIT) {
      const oldestKey = this.preloadCache.keys().next().value as string | undefined
      if (!oldestKey) return
      const img = this.preloadCache.get(oldestKey)
      if (img) {
        img.onload = null
        img.onerror = null
        img.src = ''
      }
      this.preloadCache.delete(oldestKey)
    }
  }
}
