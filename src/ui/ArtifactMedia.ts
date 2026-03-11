import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { escapeHtml } from './utils'

type PdfJsModule = typeof import('pdfjs-dist')

let pdfJsPromise: Promise<PdfJsModule> | null = null

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc
      return pdfjs
    })()
  }
  return pdfJsPromise
}

const PDF_CACHE_LIMIT = 24
const IMAGE_WARM_CACHE_LIMIT = 96

const pdfDocCache = new Map<string, PDFDocumentProxy>()
const pdfLoadingCache = new Map<string, PDFDocumentLoadingTask>()
const pdfPageCache = new Map<string, PDFPageProxy>()
const pdfAspectRatioCache = new Map<string, number>()
const pdfCacheLru = new Map<string, true>()

const imageWarmCache = new Map<string, Promise<void>>()
const imageWarmLru = new Map<string, true>()

function touchLru(lru: Map<string, true>, key: string): void {
  if (lru.has(key)) lru.delete(key)
  lru.set(key, true)
}

function enforceLruLimit(
  lru: Map<string, true>,
  maxSize: number,
  onEvict: (key: string) => void,
): void {
  while (lru.size > maxSize) {
    const oldestKey = lru.keys().next().value as string | undefined
    if (!oldestKey) return
    lru.delete(oldestKey)
    onEvict(oldestKey)
  }
}

function evictPdfUrl(url: string): void {
  const loadingTask = pdfLoadingCache.get(url)
  if (loadingTask) {
    pdfLoadingCache.delete(url)
    try {
      loadingTask.destroy()
    } catch {}
  }

  const page = pdfPageCache.get(url)
  if (page) {
    pdfPageCache.delete(url)
    try {
      page.cleanup()
    } catch {}
  }

  const doc = pdfDocCache.get(url)
  if (doc) {
    pdfDocCache.delete(url)
    try {
      doc.cleanup()
    } catch {}
    void doc.destroy().catch(() => {})
  }

  pdfAspectRatioCache.delete(url)
  pdfCacheLru.delete(url)
}

function touchPdfCache(url: string): void {
  touchLru(pdfCacheLru, url)
  enforceLruLimit(pdfCacheLru, PDF_CACHE_LIMIT, evictPdfUrl)
}

function getCachedPdfAspectRatio(url: string): number | undefined {
  const ratio = pdfAspectRatioCache.get(url)
  if (ratio && ratio > 0) touchPdfCache(url)
  return ratio
}

function setCachedPdfAspectRatio(url: string, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) return
  pdfAspectRatioCache.set(url, ratio)
  touchPdfCache(url)
}

function touchImageWarmCache(url: string): void {
  touchLru(imageWarmLru, url)
  enforceLruLimit(imageWarmLru, IMAGE_WARM_CACHE_LIMIT, (oldestKey) => {
    imageWarmCache.delete(oldestKey)
  })
}

export async function renderPdfAllPages(
  url: string,
  container: HTMLElement,
): Promise<void> {
  const pdfjs = await loadPdfJs()
  let doc = pdfDocCache.get(url)
  if (!doc) {
    let loadingTask = pdfLoadingCache.get(url)
    if (!loadingTask) {
      loadingTask = pdfjs.getDocument(url)
      pdfLoadingCache.set(url, loadingTask)
    }
    try {
      doc = await loadingTask.promise
    } finally {
      if (pdfLoadingCache.get(url) === loadingTask) {
        pdfLoadingCache.delete(url)
      }
    }
    pdfDocCache.set(url, doc)
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const containerWidth = container.clientWidth || 800
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const unscaledViewport = page.getViewport({ scale: 1 })
    const scale = (containerWidth * dpr) / unscaledViewport.width
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = '100%'
    canvas.style.display = 'block'
    container.appendChild(canvas)
    const ctx = canvas.getContext('2d')!
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
  }
}

export function clearArtifactMediaCaches(): void {
  for (const url of Array.from(pdfDocCache.keys())) evictPdfUrl(url)
  for (const url of Array.from(pdfLoadingCache.keys())) evictPdfUrl(url)
  for (const url of Array.from(pdfPageCache.keys())) evictPdfUrl(url)

  pdfDocCache.clear()
  pdfLoadingCache.clear()
  pdfPageCache.clear()
  pdfAspectRatioCache.clear()
  pdfCacheLru.clear()

  imageWarmCache.clear()
  imageWarmLru.clear()
}

export function getArtifactMediaCacheStats(): {
  pdfDocuments: number
  pdfLoadingTasks: number
  pdfPages: number
  pdfAspectRatios: number
  warmedImages: number
} {
  return {
    pdfDocuments: pdfDocCache.size,
    pdfLoadingTasks: pdfLoadingCache.size,
    pdfPages: pdfPageCache.size,
    pdfAspectRatios: pdfAspectRatioCache.size,
    warmedImages: imageWarmCache.size,
  }
}

export function renderArtifactGallery(
  artifacts: Record<string, string>,
  buildUrl: (path: string) => string,
): { html: string; attach: (container: HTMLElement) => void; detach: () => void } {
  const entries = Object.entries(artifacts)
  if (entries.length === 0) return { html: '', attach: () => {}, detach: () => {} }

  const isPdfArtifact = (path: string) => /\.pdf(?:$|[?#])/i.test(path)
  let pdfRenderNonce = 0
  let pdfResizeObserver: ResizeObserver | null = null
  let observedWidth = 0
  let resizeRaf = 0

  const clearPdfResizeObserver = () => {
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = 0
    }
    if (!pdfResizeObserver) return
    pdfResizeObserver.disconnect()
    pdfResizeObserver = null
  }

  const getPdfPage = async (url: string): Promise<PDFPageProxy | null> => {
    try {
      const cachedPage = pdfPageCache.get(url)
      if (cachedPage) {
        touchPdfCache(url)
        return cachedPage
      }

      let pdfDoc = pdfDocCache.get(url)
      if (pdfDoc) touchPdfCache(url)
      if (!pdfDoc) {
        let loadingTask = pdfLoadingCache.get(url)
        if (!loadingTask) {
          const pdfjs = await loadPdfJs()
          loadingTask = pdfjs.getDocument(url)
          pdfLoadingCache.set(url, loadingTask)
        }
        touchPdfCache(url)
        try {
          pdfDoc = await loadingTask.promise
        } finally {
          if (pdfLoadingCache.get(url) === loadingTask) {
            pdfLoadingCache.delete(url)
          }
        }
        pdfDocCache.set(url, pdfDoc)
        touchPdfCache(url)
      }

      const page = await pdfDoc.getPage(1)
      pdfPageCache.set(url, page)
      touchPdfCache(url)
      return page
    } catch {
      evictPdfUrl(url)
      return null
    }
  }

  const warmPdf = async (path: string): Promise<number | null> => {
    const url = buildUrl(path)
    const cached = getCachedPdfAspectRatio(url)
    if (cached && cached > 0) return cached
    const page = await getPdfPage(url)
    if (!page) return null
    const viewport = page.getViewport({ scale: 1 })
    const ratio = viewport.width / viewport.height
    if (Number.isFinite(ratio) && ratio > 0) {
      setCachedPdfAspectRatio(url, ratio)
      return ratio
    }
    return null
  }

  const warmImage = async (path: string): Promise<void> => {
    const url = buildUrl(path)
    let warm = imageWarmCache.get(url)
    if (warm) touchImageWarmCache(url)
    if (!warm) {
      warm = new Promise<void>((resolve) => {
        const img = new Image()
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          img.onload = null
          img.onerror = null
          resolve()
        }
        img.onload = finish
        img.onerror = finish
        img.src = url
        if ('decode' in img) void img.decode().then(finish).catch(finish)
      })
      imageWarmCache.set(url, warm)
      touchImageWarmCache(url)
    }
    await warm
  }

  const warmArtifact = async (path: string): Promise<void> => {
    if (isPdfArtifact(path)) {
      await warmPdf(path)
      return
    }
    await warmImage(path)
  }

  const setPdfAspectFromCache = (media: HTMLElement, path: string) => {
    const ratio = getCachedPdfAspectRatio(buildUrl(path))
    if (ratio && ratio > 0) media.style.setProperty('--pdf-aspect-ratio', `${ratio}`)
  }

  const renderPdfPreview = async (container: HTMLElement, path: string): Promise<void> => {
    if (!isPdfArtifact(path)) return
    const media = container.querySelector('.tapestry-artifact .artifact-media.pdf') as HTMLElement | null
    if (!media || media.dataset.artifactPath !== path) return
    const canvas = media.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return

    const renderId = ++pdfRenderNonce
    const url = buildUrl(path)
    setPdfAspectFromCache(media, path)
    const page = await getPdfPage(url)
    if (!page) {
      if (media.isConnected && media.dataset.artifactPath === path) {
        media.classList.remove('loading')
      }
      return
    }
    if (!media.isConnected || media.dataset.artifactPath !== path || renderId !== pdfRenderNonce) return

    const baseViewport = page.getViewport({ scale: 1 })
    const ratio = baseViewport.width / baseViewport.height
    if (Number.isFinite(ratio) && ratio > 0) {
      setCachedPdfAspectRatio(url, ratio)
      media.style.setProperty('--pdf-aspect-ratio', `${ratio}`)
    }

    let lastWidth = 0
    let rendering = false
    let pending = false

    const draw = async (force = false) => {
      if (!media.isConnected || media.dataset.artifactPath !== path || renderId !== pdfRenderNonce) return
      const width = Math.max(1, Math.floor(media.clientWidth))
      if (!force && width === lastWidth) return
      if (rendering) {
        pending = true
        return
      }
      rendering = true

      const base = page.getViewport({ scale: 1 })
      const scale = width / base.width
      const viewport = page.getViewport({ scale })
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const context = canvas.getContext('2d')
      if (!context) {
        rendering = false
        return
      }

      try {
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr))
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr))
        canvas.style.height = `${viewport.height}px`

        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.imageSmoothingEnabled = true
        context.setTransform(dpr, 0, 0, dpr, 0, 0)

        await page.render({ canvas, canvasContext: context, viewport }).promise
        lastWidth = width
        if (media.isConnected && media.dataset.artifactPath === path && renderId === pdfRenderNonce) {
          media.classList.remove('loading')
        }
      } finally {
        rendering = false
        if (pending) {
          pending = false
          void draw()
        }
      }
    }

    await draw(true)
    clearPdfResizeObserver()
    observedWidth = Math.max(1, Math.floor(media.clientWidth))
    pdfResizeObserver = new ResizeObserver((entries) => {
      const nextWidth = Math.max(1, Math.floor(entries[0]?.contentRect.width ?? media.clientWidth))
      if (nextWidth === observedWidth) return
      observedWidth = nextWidth
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        void draw()
      })
    })
    pdfResizeObserver.observe(media)
  }

  const mediaHtml = (name: string, path: string) => {
    const url = buildUrl(path)
    if (isPdfArtifact(path)) {
      const cachedRatio = getCachedPdfAspectRatio(url)
      const aspectStyle = cachedRatio && cachedRatio > 0 ? ` style="--pdf-aspect-ratio:${cachedRatio}"` : ''
      return `
        <div class="artifact-media pdf loading" data-artifact-path="${escapeHtml(path)}"${aspectStyle}>
          <canvas class="artifact-pdf-canvas" data-artifact-name="${escapeHtml(name)}" data-artifact-type="pdf" aria-label="${escapeHtml(name)} preview"></canvas>
          <button type="button" class="artifact-open-overlay" data-artifact-name="${escapeHtml(name)}" title="Open in lightbox" aria-label="Open ${escapeHtml(name)} in lightbox"></button>
        </div>`
    }
    return `
      <div class="artifact-media image loading" data-artifact-path="${escapeHtml(path)}">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" data-artifact-name="${escapeHtml(name)}" data-artifact-type="image" loading="lazy" />
      </div>`
  }

  let currentIndex = 0
  const hasMultiple = entries.length > 1

  const [name0, path0] = entries[0]
  const html = `
    <div class="tapestry-artifact-viewer">
      ${hasMultiple ? `<span class="artifact-nav" data-delta="-1">\u2190</span>` : ''}
      <div class="tapestry-artifact">
        <span class="artifact-label">${escapeHtml(name0)}${hasMultiple ? ` (1/${entries.length})` : ''}</span>
        ${mediaHtml(name0, path0)}
      </div>
      ${hasMultiple ? `<span class="artifact-nav" data-delta="1">\u2192</span>` : ''}
    </div>`

  const markImageLoaded = (container: HTMLElement, path: string) => {
    if (isPdfArtifact(path)) return
    const media = container.querySelector('.tapestry-artifact .artifact-media.image') as HTMLElement | null
    if (!media || media.dataset.artifactPath !== path) return
    const img = media.querySelector('img')
    if (!img) return
    const onLoad = () => {
      if (media.isConnected && media.dataset.artifactPath === path) media.classList.remove('loading')
    }
    if ((img as HTMLImageElement).complete) onLoad()
    else img.addEventListener('load', onLoad, { once: true })
    img.addEventListener('error', onLoad, { once: true })
  }

  const warmAdjacent = (index: number) => {
    if (entries.length < 2) return
    const prev = entries[(index - 1 + entries.length) % entries.length]?.[1]
    const next = entries[(index + 1) % entries.length]?.[1]
    if (prev) void warmArtifact(prev)
    if (next) void warmArtifact(next)
  }

  const updateImg = (container: HTMLElement) => {
    const [name, path] = entries[currentIndex]
    const media = container.querySelector('.tapestry-artifact .artifact-media') as HTMLElement | null
    clearPdfResizeObserver()
    if (media) media.outerHTML = mediaHtml(name, path)
    const label = container.querySelector('.artifact-label')
    if (label) label.textContent = `${name}${hasMultiple ? ` (${currentIndex + 1}/${entries.length})` : ''}`
    if (isPdfArtifact(path)) void renderPdfPreview(container, path)
    else markImageLoaded(container, path)
    warmAdjacent(currentIndex)
  }

  let keyHandler: ((e: KeyboardEvent) => void) | null = null

  const attach = (container: HTMLElement) => {
    void warmArtifact(entries[currentIndex][1])
    warmAdjacent(currentIndex)
    const [, initialPath] = entries[currentIndex]
    if (isPdfArtifact(initialPath)) void renderPdfPreview(container, initialPath)
    else markImageLoaded(container, initialPath)

    container.querySelectorAll('.artifact-nav').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const delta = parseInt((btn as HTMLElement).dataset.delta || '0')
        currentIndex = (currentIndex + delta + entries.length) % entries.length
        updateImg(container)
      })
    })

    if (hasMultiple) {
      keyHandler = (e: KeyboardEvent) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const delta = e.key === 'ArrowLeft' ? -1 : 1
        currentIndex = (currentIndex + delta + entries.length) % entries.length
        updateImg(container)
      }
      document.addEventListener('keydown', keyHandler)
    }
  }

  const detach = () => {
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = 0
    }
    clearPdfResizeObserver()
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler)
      keyHandler = null
    }
  }

  return { html, attach, detach }
}
