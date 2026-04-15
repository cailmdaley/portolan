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

/**
 * Full-viewport vellum file modal backed by a read-only static adapter. Used
 * by the GitHub Pages tapestry deploy where no server is available — files
 * come from the flat `${staticDataBase}/files/` tree written by
 * `felt export --format tapestry`.
 */
export interface FiberCardPreviewOptions {
  cityId?: string
  originId?: string
  width?: number
}

export interface FiberCardPreviewHandle {
  /**
   * Render the card for a new GraphNode. Passing null clears the card.
   * Optional `content` threads the fiber body's mdast through so FiberCard
   * renders the prose lede below the pretext lockup.
   */
  update(node: GraphNode | null, width?: number, content?: FiberContent | null): void
  /** Fetch the fiber body via the mounted adapter. Returns null on miss. */
  fetchContent(slug: string): Promise<FiberContent | null>
  unmount(): void
}

/**
 * Mount vellum's FiberCard into an arbitrary container. Intended for the
 * pinned-card hover preview on the portolan map — the same fiber primitive
 * the reader uses, rendered in a small tooltip-sized surface so the map
 * previews what the reader would open. See tapestry-dissolves.
 */
export function mountVellumFiberCardPreview(
  container: HTMLElement,
  opts: FiberCardPreviewOptions = {},
): FiberCardPreviewHandle {
  const root = createRoot(container)
  const adapter = createPortolanAdapter({
    cityId: opts.cityId,
    defaultOriginId: opts.originId,
  })
  const defaultWidth = opts.width ?? 280

  const render = (node: GraphNode | null, width: number, content: FiberContent | null) => {
    if (!node) {
      root.render(<StrictMode />)
      return
    }
    root.render(
      <StrictMode>
        <AdapterProvider adapter={adapter}>
          <FiberCard node={node} width={width} content={content ?? undefined} />
        </AdapterProvider>
      </StrictMode>,
    )
  }

  return {
    update(node, width, content) {
      render(node, width ?? defaultWidth, content ?? null)
    },
    async fetchContent(slug) {
      if (!adapter.getFiberContent) return null
      try {
        return await adapter.getFiberContent(slug)
      } catch {
        return null
      }
    },
    unmount() {
      root.unmount()
    },
  }
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
 *
 * Sibling of `mountVellumFiberCardPreview` (hover tooltip). Difference: this
 * returns an update() that re-renders for a new slug on the same container.
 */
export function mountVellumFiberSurface(
  container: HTMLElement,
  opts: MountFiberSurfaceOptions,
): VellumFiberSurfaceHandle {
  const root = createRoot(container)
  let unmounted = false
  let currentSlug = opts.slug

  const render = (next: MountFiberSurfaceOptions) => {
    currentSlug = next.slug
    const width = next.width ?? 320
    const adapter = createPortolanAdapter({
      cityId: next.cityId,
      defaultOriginId: next.originId,
    })
    const paint = (node: GraphNode | null, content: FiberContent | null) => {
      if (unmounted) return
      if (!node) {
        root.render(<StrictMode />)
        return
      }
      root.render(
        <StrictMode>
          <AdapterProvider adapter={adapter}>
            <FiberCard
              node={node}
              width={width}
              content={content ?? undefined}
              onNavigate={next.onNavigate}
            />
          </AdapterProvider>
        </StrictMode>,
      )
    }
    paint(next.seedNode ?? null, null)
    if (adapter.getFiberContent) {
      void adapter.getFiberContent(next.slug).then((content) => {
        if (unmounted || currentSlug !== next.slug) return
        const node =
          next.seedNode ??
          ({
            id: next.slug,
            slug: next.slug,
            label: next.slug,
            status: 'open',
            kind: 'fiber',
            tags: [],
          } as GraphNode)
        paint(node, content ?? null)
      }).catch(() => {})
    }
  }

  render(opts)

  return {
    update(next) { render(next) },
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
