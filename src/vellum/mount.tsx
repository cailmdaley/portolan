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
  type Annotation,
  type AnnotationAction,
  type FiberContent,
  type GraphNode,
} from 'vellum'
import 'vellum/css'
import { createPortolanAdapter, createPortolanStaticAdapter } from './portolan-adapter'

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

/**
 * Minimal shape of portolan frontend state this file needs to route annotation
 * actions. main.ts registers getters that read the module-scoped `sessions`
 * and `cities` lists; the closures see the latest values after every WS
 * state update.
 *
 * Kept intentionally narrow: only the fields the action handlers actually
 * consume. Keeps the type surface decoupled from `src/state/types.ts` so
 * this mount layer doesn't drag the whole state graph into vellum.
 */
export interface PortolanMountContext {
  getSessions: () => Array<{ id: string; cityId: string | null; originId: string }>
  getCities: () => Array<{ id: string; path: string; originId: string }>
}

let mountContext: PortolanMountContext | null = null

/**
 * Install the portolan state getters that the annotation-action handlers
 * defined below need in order to pick a worker to send to, or resolve the
 * city path for `felt add`. Call once after the frontend state sync is
 * wired up. Null-safe: if no context is registered, actions degrade to
 * create-new-worker for /send-annotations and omit `cityPath` for
 * /file-as-fiber (the server then derives cityPath from filePath).
 */
export function setPortolanMountContext(ctx: PortolanMountContext | null): void {
  mountContext = ctx
}

function pickWorkerId(cityId: string | undefined, originId: string): string | null {
  if (!cityId || !mountContext) return null
  const workers = mountContext.getSessions().filter(
    (s) => s.cityId === cityId && s.originId === originId,
  )
  return workers[0]?.id ?? null
}

function resolveCityPath(cityId: string | undefined, originId: string): string | null {
  if (!cityId || !mountContext) return null
  const city = mountContext.getCities().find(
    (c) => c.id === cityId && c.originId === originId,
  )
  return city?.path ?? null
}

async function sendAnnotationToWorker(
  path: string,
  originId: string,
  cityId: string | undefined,
  annotation: Annotation,
): Promise<void> {
  const workerId = pickWorkerId(cityId, originId)
  const body: Record<string, unknown> = {
    filePath: path,
    originId,
    annotations: [annotation],
  }
  if (workerId) body.workerId = workerId
  else body.createNewWorker = true
  const res = await fetch(`${API_BASE}/send-annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[annotation-actions] send-to-worker failed', res.status, detail)
  }
}

async function saveAnnotationAsFiber(
  path: string,
  originId: string,
  cityId: string | undefined,
  annotation: Annotation,
): Promise<void> {
  const filename = path.split('/').pop() ?? path
  const title = `Note on ${filename}`
  const lineRef = annotation.line
    ? annotation.endLine && annotation.endLine !== annotation.line
      ? ` (L${annotation.line}-${annotation.endLine})`
      : ` (L${annotation.line})`
    : ''
  const quoted = annotation.originalText ?? annotation.selectedText ?? ''
  const bodyLines = [`${path}${lineRef}`, '']
  if (quoted) {
    for (const line of quoted.split('\n')) bodyLines.push(`> ${line}`)
    bodyLines.push('')
  }
  bodyLines.push(annotation.comment)
  const cityPath = resolveCityPath(cityId, originId) ?? undefined
  const res = await fetch(`${API_BASE}/file-as-fiber`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: path,
      originId,
      cityPath,
      title,
      body: bodyLines.join('\n'),
      kind: 'note',
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[annotation-actions] save-as-fiber failed', res.status, detail)
  }
}

/**
 * Build the two portolan annotation actions bound to a specific file mount.
 * Each mount call (modal, surface, inline) captures its own `{path, originId,
 * cityId}` so the handler knows where the annotation lives. The actions
 * read `mountContext` lazily on invoke — not on build — so they always see
 * the latest worker/city state.
 */
function portolanAnnotationActions(args: {
  path: string
  originId: string
  cityId?: string
}): AnnotationAction[] {
  return [
    {
      id: 'send-to-worker',
      label: 'Send',
      title: 'Send to worker',
      onInvoke: (ann) => sendAnnotationToWorker(args.path, args.originId, args.cityId, ann),
    },
    {
      id: 'save-as-fiber',
      label: 'Fiber',
      title: 'Save as fiber',
      onInvoke: (ann) => saveAnnotationAsFiber(args.path, args.originId, args.cityId, ann),
    },
  ]
}

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
            annotationActions={portolanAnnotationActions({
              path: opts.path,
              originId: opts.originId ?? 'local',
              cityId: opts.cityId,
            })}
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
            annotationActions={portolanAnnotationActions({
              path: next.path,
              originId: next.originId ?? 'local',
              cityId: next.cityId,
            })}
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
          annotationActions={portolanAnnotationActions({
            path: opts.path,
            originId: opts.originId ?? 'local',
            cityId: opts.cityId,
          })}
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
