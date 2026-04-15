/**
 * Vellum mount seams for portolan.
 *
 * Two entry points:
 *
 *   - mountVellumFileViewer(container, …) — raw page mount, used when the
 *     host already owns a container and wants FileViewerPage inside it
 *     (e.g. inline panels, debug surfaces).
 *   - openVellumFileModal({ path, … }) — full-viewport modal: creates a scrim
 *     container, mounts vellum's FileViewerModal inside, and returns a close
 *     handle. Replaces the hand-rolled overlay main.ts used to roll itself.
 *
 * Everything outside this file stays vanilla TS/Three.js. React only lives
 * inside the React root this file creates — see vellum-in-portolan.
 */

import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  AdapterProvider,
  FiberCard,
  FileViewerModal,
  FileViewerPage,
  WorkspaceMount,
  type FiberContent,
  type GraphNode,
} from 'vellum'
import 'vellum/css'
import { createPortolanAdapter, createPortolanStaticAdapter } from './portolan-adapter'

export interface MountFileViewerOptions {
  container: HTMLElement
  path: string
  originId?: string
  cityId?: string
  cacheBust?: boolean
  editable?: boolean
  jumpToLine?: number
}

export interface VellumMountHandle {
  update(options: Omit<MountFileViewerOptions, 'container'>): void
  unmount(): void
}

export function mountVellumFileViewer(options: MountFileViewerOptions): VellumMountHandle {
  const root: Root = createRoot(options.container)

  const render = (opts: Omit<MountFileViewerOptions, 'container'>) => {
    const adapter = createPortolanAdapter({
      cityId: opts.cityId,
      defaultOriginId: opts.originId,
    })
    root.render(
      <StrictMode>
        <AdapterProvider adapter={adapter}>
          <FileViewerPage
            path={opts.path}
            originId={opts.originId}
            cacheBust={opts.cacheBust}
            editable={opts.editable}
            jumpToLine={opts.jumpToLine}
          />
        </AdapterProvider>
      </StrictMode>,
    )
  }

  render(options)

  return {
    update(opts) {
      render(opts)
    },
    unmount() {
      root.unmount()
    },
  }
}

export interface MountFileSurfaceOptions {
  /** File path resolved by the active adapter. */
  path: string
  originId?: string
  cityId?: string
  editable?: boolean
  jumpToLine?: number
}

export interface VellumFileSurfaceHandle {
  /** Re-render with new file/options. */
  update(opts: MountFileSurfaceOptions): void
  unmount(): void
}

/**
 * Non-modal mount of vellum's `FileViewerPage` into an arbitrary container.
 * Same fetch + render pipeline as `openVellumFileModal`, no scrim or chrome.
 *
 * Used by the floating-card primitive (see [[file-view-as-floating-card]]) and
 * any other host that wants vellum's file rendering inline. The container
 * controls sizing; vellum fills it.
 */
export function mountVellumFileSurface(
  container: HTMLElement,
  opts: MountFileSurfaceOptions,
): VellumFileSurfaceHandle {
  const root = createRoot(container)

  const render = (next: MountFileSurfaceOptions) => {
    const adapter = createPortolanAdapter({
      cityId: next.cityId,
      defaultOriginId: next.originId,
    })
    root.render(
      <StrictMode>
        <AdapterProvider adapter={adapter}>
          <FileViewerPage
            path={next.path}
            originId={next.originId}
            editable={next.editable}
            jumpToLine={next.jumpToLine}
          />
        </AdapterProvider>
      </StrictMode>,
    )
  }

  render(opts)

  return {
    update(next) {
      render(next)
    },
    unmount() {
      root.unmount()
    },
  }
}

export interface OpenFileModalOptions {
  path: string
  originId?: string
  cityId?: string
  editable?: boolean
  jumpToLine?: number
}

export interface VellumModalHandle {
  close(): void
}

/**
 * Full-viewport vellum file modal. Creates its own container, mounts
 * FileViewerModal with an AdapterProvider, and tears down on close.
 */
export function openVellumFileModal(opts: OpenFileModalOptions): VellumModalHandle {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const adapter = createPortolanAdapter({
    cityId: opts.cityId,
    defaultOriginId: opts.originId,
  })

  const close = () => {
    root.unmount()
    container.remove()
  }

  root.render(
    <StrictMode>
      <AdapterProvider adapter={adapter}>
        <FileViewerModal
          path={opts.path}
          originId={opts.originId}
          cityId={opts.cityId}
          editable={opts.editable}
          jumpToLine={opts.jumpToLine}
          onClose={close}
        />
      </AdapterProvider>
    </StrictMode>,
  )

  return { close }
}

export interface OpenWorkspaceModalOptions {
  cityId: string
  /** Initial fiber slug to land on. Typically `<cityId>/<cityId>` (the city's root fiber). */
  initialSlug?: string
  originId?: string
}

/**
 * Full-viewport vellum workspace modal for a portolan city. Mounts
 * vellum's WorkspaceMount (narrative / workspace / delta / map modes) against
 * the PortolanAdapter for the given city. Replaces the native TapestryView
 * on `t` / deep-press; see tapestry-dissolves.
 */
export function openVellumWorkspaceModal(opts: OpenWorkspaceModalOptions): VellumModalHandle {
  const container = document.createElement('div')
  container.className = 'vellum-workspace-modal-container'
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1000',
    background: 'var(--porch-panel, #ede8e0)',
    overflow: 'hidden',
  })
  document.body.appendChild(container)
  const root = createRoot(container)

  const adapter = createPortolanAdapter({
    cityId: opts.cityId,
    defaultOriginId: opts.originId,
  })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    root.unmount()
    container.remove()
    document.removeEventListener('keydown', onKey, true)
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }
  document.addEventListener('keydown', onKey, true)

  const mountWith = (initialSlug: string) => {
    if (closed) return
    root.render(
      <StrictMode>
        <AdapterProvider adapter={adapter}>
          <WorkspaceMount initialSlug={initialSlug} />
        </AdapterProvider>
      </StrictMode>,
    )
  }

  if (opts.initialSlug) {
    mountWith(opts.initialSlug)
  } else {
    // Ask the server which fiber is the city's root (handles projects whose
    // root slug isn't `{cityId}/{cityId}`); fall back to the convention on
    // network error. See fiber city-to-fiber-slug-mapping.
    resolveCityRootSlug(opts.cityId)
      .then((slug) => mountWith(slug ?? `${opts.cityId}/${opts.cityId}`))
      .catch(() => mountWith(`${opts.cityId}/${opts.cityId}`))
  }

  return { close }
}

async function resolveCityRootSlug(cityId: string): Promise<string | null> {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const res = await fetch(`http://${host}:4004/astra/graph?cityId=${encodeURIComponent(cityId)}`)
  if (!res.ok) return null
  const data = await res.json()
  return typeof data.rootSlug === 'string' ? data.rootSlug : null
}

export interface OpenStaticFileModalOptions {
  /** File href as it appears in the tapestry export (absolute, `./`, or relative). */
  path: string
  /** Base URL for the static tapestry export (e.g. "./data/pure_eb"). */
  staticDataBase: string
  jumpToLine?: number
}

export interface MountFiberSurfaceOptions {
  slug: string
  cityId?: string
  originId?: string
  width?: number
  /** Optional seed node used for the first paint before the adapter fetch
   *  resolves. Typically built from the HUD fiber list so the card shows a
   *  title/status immediately instead of flashing empty. */
  seedNode?: GraphNode | null
  onNavigate?: (slug: string) => void
  /** When true, the FiberCard's title lockup line is suppressed. Used by
   *  the portolan floating-card primitive, where the chrome strip above
   *  the card already carries the fiber name + status glyph, so repeating
   *  it inside the card body is pure duplication. See
   *  fiber-pin-title-duplication. */
  hideTitle?: boolean
}

export interface VellumFiberSurfaceHandle {
  update(opts: MountFiberSurfaceOptions): void
  unmount(): void
}

/**
 * Non-modal mount of vellum's FiberCard into an arbitrary container. Fetches
 * the fiber's body via the PortolanAdapter and paints the full card
 * (pretext lockup + prose lede + tags). Used by the floating-card primitive
 * for fiber-kind pins — see [[file-view-as-floating-card]] and
 * `tapestry-dissolves` Next: "Fiber pins as DOM cards too."
 */
export function mountVellumFiberSurface(
  container: HTMLElement,
  opts: MountFiberSurfaceOptions,
): VellumFiberSurfaceHandle {
  const root = createRoot(container)
  let unmounted = false
  let currentOpts = opts
  let cachedContent: FiberContent | null = null
  let cachedNode: GraphNode | null = opts.seedNode ?? null
  let adapter = createPortolanAdapter({
    cityId: opts.cityId,
    defaultOriginId: opts.originId,
  })

  const paint = () => {
    if (unmounted) return
    const width = currentOpts.width ?? 320
    if (!cachedNode) {
      root.render(<StrictMode />)
      return
    }
    root.render(
      <StrictMode>
        <AdapterProvider adapter={adapter}>
          <FiberCard
            node={cachedNode}
            width={width}
            content={cachedContent ?? undefined}
            onNavigate={currentOpts.onNavigate}
            hideTitle={currentOpts.hideTitle}
          />
        </AdapterProvider>
      </StrictMode>,
    )
  }

  const fetchContent = (slug: string) => {
    if (!adapter.getFiberContent) return
    void adapter.getFiberContent(slug).then((content) => {
      if (unmounted || currentOpts.slug !== slug) return
      cachedContent = content ?? null
      // Without a seedNode, derive the node from the fiber's frontmatter so
      // tags, status, and outcome actually land in FiberCard. The prior
      // fallback constructed an empty-looking node (status:'open', tags:[],
      // label:slug) that dropped everything FiberCard needs to render.
      const fm = content?.frontmatter ?? {}
      cachedNode =
        currentOpts.seedNode ??
        ({
          id: slug,
          slug,
          label: typeof fm.name === 'string' && fm.name.length > 0 ? fm.name : slug,
          status: typeof fm.status === 'string' ? fm.status : 'open',
          kind: 'fiber',
          tags: Array.isArray(fm.tags) ? fm.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
          verdict: typeof fm.outcome === 'string' ? fm.outcome : undefined,
          tempered: fm.tempered === true,
        } as GraphNode)
      paint()
    }).catch(() => {})
  }

  const applyUpdate = (next: MountFiberSurfaceOptions) => {
    const prev = currentOpts
    currentOpts = next
    const slugChanged = prev.slug !== next.slug
    const cityChanged = prev.cityId !== next.cityId || prev.originId !== next.originId
    if (slugChanged || cityChanged) {
      if (cityChanged) {
        adapter = createPortolanAdapter({
          cityId: next.cityId,
          defaultOriginId: next.originId,
        })
      }
      cachedContent = null
      cachedNode = next.seedNode ?? null
      paint()
      fetchContent(next.slug)
      return
    }
    // Width / hideTitle / onNavigate tweak only — re-render with cached content.
    paint()
  }

  paint()
  fetchContent(opts.slug)

  return {
    update(next) { applyUpdate(next) },
    unmount() {
      unmounted = true
      root.unmount()
    },
  }
}

export function openVellumStaticFileModal(opts: OpenStaticFileModalOptions): VellumModalHandle {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const adapter = createPortolanStaticAdapter({ staticDataBase: opts.staticDataBase })

  const close = () => {
    root.unmount()
    container.remove()
  }

  root.render(
    <StrictMode>
      <AdapterProvider adapter={adapter}>
        <FileViewerModal
          path={opts.path}
          editable={false}
          jumpToLine={opts.jumpToLine}
          onClose={close}
        />
      </AdapterProvider>
    </StrictMode>,
  )

  return { close }
}
