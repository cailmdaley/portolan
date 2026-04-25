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

import { createRoot, type Root } from 'react-dom/client'
import {
  AdapterProvider,
  FiberCard,
  FileViewerModal,
  FileViewerPage,
  WorkspaceMount,
  type Annotation,
  type AnnotationBulkAction,
  type FiberContent,
  type GraphNode,
} from 'vellum'
import 'vellum/css'
import { createPortolanAdapter, createPortolanStaticAdapter } from './portolan-adapter'
import { openWorkerPicker, type WorkerOption, type WorkerPickerChoice } from './workerPicker'
import { showToast } from '../ui/utils'
import { lockModalBackground } from '../ui/modalBackgroundLock'

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
  getSessions: () => Array<{
    id: string
    name: string
    cityId: string | null
    originId: string
    status: 'idle' | 'working'
  }>
  getCities: () => Array<{ id: string; name?: string; path: string; originId: string }>
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

/**
 * Every known worker, annotated with its city name so the picker can split
 * current-project vs other workers and show city-context for the "other"
 * bucket. A session without a resolved cityId (rare: brand-new tmux whose
 * cwd hasn't matched a city yet) still shows up — just under "other" with
 * no city label.
 */
function listAllWorkers(): WorkerOption[] {
  if (!mountContext) return []
  const cities = mountContext.getCities()
  const cityById = new Map(cities.map((c) => [c.id, c]))
  return mountContext.getSessions().map((s) => {
    const city = s.cityId ? cityById.get(s.cityId) : undefined
    const cityName = city ? (city.name ?? city.path.split('/').pop() ?? city.path) : null
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      originId: s.originId,
      cityId: s.cityId,
      cityName,
    }
  })
}

function resolveCity(
  cityId: string | undefined,
  originId: string,
): { path: string; name: string } | null {
  if (!cityId || !mountContext) return null
  const city = mountContext.getCities().find(
    (c) => c.id === cityId && c.originId === originId,
  )
  if (!city) return null
  const name = city.name ?? city.path.split('/').pop() ?? city.path
  return { path: city.path, name }
}

async function postSendAnnotations(body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${API_BASE}/send-annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[annotation-actions] send-to-worker failed', res.status, detail)
    showToast('Send failed', 'error')
    return false
  }
  showToast('Sent to worker', 'success', 2000)
  return true
}

async function sendAnnotationsToChoice(args: {
  path: string
  originId: string
  cityId: string | undefined
  annotations: Annotation[]
  choice: WorkerPickerChoice
  refreshAnnotations: () => void
}): Promise<void> {
  const body: Record<string, unknown> = {
    filePath: args.path,
    annotations: args.annotations,
  }

  if (args.choice.kind === 'existing') {
    // Route by the target WORKER'S origin, not the file's. This is what
    // lets "send" reach a worker in a different project — possibly on a
    // different host. `cityPath` is ignored by the server for existing
    // workers (it's only used to set cwd when creating a new worker), but
    // include the worker's city for completeness/debuggability.
    const worker = args.choice.worker
    body.workerId = worker.id
    body.originId = worker.originId
    if (mountContext) {
      const targetCity = mountContext
        .getCities()
        .find((c) => c.id === worker.cityId && c.originId === worker.originId)
      if (targetCity) body.cityPath = targetCity.path
    }
  } else {
    // New worker lives in the CURRENT project's city. Use the file's
    // origin/city for that — opening a file in a project implies spawning
    // a new worker for that same project, not wherever the picker was
    // showing "other" workers from.
    const city = resolveCity(args.cityId, args.originId)
    body.originId = args.originId
    body.createNewWorker = true
    if (city?.path) body.cityPath = city.path
  }

  const ok = await postSendAnnotations(body)
  // Server marked each annotation's sentAt on success. Pull the fresh state
  // so the chrome can light up "Clear sent" against the dispatched subset.
  if (ok) args.refreshAnnotations()
}

async function deleteAnnotationsById(
  ids: string[],
  refreshAnnotations: () => void,
): Promise<void> {
  if (ids.length === 0) return
  const results = await Promise.allSettled(
    ids.map((id) =>
      fetch(`${API_BASE}/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then((res) => {
          if (!res.ok) throw new Error(`DELETE /annotations/${id} → ${res.status}`)
        }),
    ),
  )
  const failed = results.filter((r) => r.status === 'rejected').length
  refreshAnnotations()
  if (failed > 0) {
    showToast(`Cleared ${ids.length - failed}/${ids.length}; ${failed} failed`, 'error')
  } else {
    showToast(`Cleared ${ids.length} sent`, 'success', 2000)
  }
}

async function saveAnnotationsAsFiber(args: {
  path: string
  originId: string
  cityId: string | undefined
  annotations: Annotation[]
}): Promise<void> {
  const { path, originId, cityId, annotations } = args
  if (annotations.length === 0) return
  const filename = path.split('/').pop() ?? path
  const title =
    annotations.length === 1
      ? `Note on ${filename}`
      : `${annotations.length} notes on ${filename}`

  const sections: string[] = [path, '']
  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i]
    const lineRef = ann.line
      ? ann.endLine && ann.endLine !== ann.line
        ? ` (L${ann.line}-${ann.endLine})`
        : ` (L${ann.line})`
      : ''
    const header =
      annotations.length === 1 ? `${path}${lineRef}` : `## ${i + 1}.${lineRef}`
    if (annotations.length > 1) sections.push(header)
    const quoted = ann.originalText ?? ann.selectedText ?? ''
    if (quoted) {
      for (const line of quoted.split('\n')) sections.push(`> ${line}`)
      sections.push('')
    }
    sections.push(ann.comment)
    sections.push('')
  }

  const cityPath = resolveCity(cityId, originId)?.path
  const res = await fetch(`${API_BASE}/file-as-fiber`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: path,
      originId,
      cityPath,
      title,
      body: sections.join('\n'),
      kind: 'note',
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[annotation-actions] save-as-fiber failed', res.status, detail)
    showToast('Save as fiber failed', 'error')
    return
  }
  const result = await res.json().catch(() => ({} as { fiberId?: string }))
  showToast(
    result.fiberId ? `Filed as fiber: ${result.fiberId}` : 'Filed as fiber',
    'success',
    2500,
  )
}

/**
 * Header-level bulk actions for a specific file mount: Send to worker (opens
 * a picker of existing workers in the file's city + New worker) and Fiber
 * (collapses all comments into one fiber body). The actions read the
 * mountContext lazily so they always see the latest worker/city state.
 */
function portolanHeaderActions(args: {
  path: string
  originId: string
  cityId?: string
}): AnnotationBulkAction[] {
  return [
    {
      id: 'send-to-worker',
      label: 'Send',
      title: 'Send comments to a worker',
      onInvoke: (annotations, ctx) => {
        const workers = listAllWorkers()
        const city = resolveCity(args.cityId, args.originId)
        openWorkerPicker({
          anchor: ctx.anchor,
          workers,
          currentCityId: args.cityId ?? null,
          currentProjectLabel: city?.name ?? 'project',
          onPick: (choice) => {
            void sendAnnotationsToChoice({
              path: args.path,
              originId: args.originId,
              cityId: args.cityId,
              annotations,
              choice,
              refreshAnnotations: ctx.refreshAnnotations,
            })
          },
        })
      },
    },
    {
      // Clean up after a send. Only visible when at least one annotation
      // carries sentAt; the count badge reflects just the sent subset; the
      // action deletes that subset. Unsent annotations are left alone so
      // in-progress notes aren't lost.
      id: 'clear-sent',
      label: 'Clear sent',
      title: 'Delete annotations that have been sent to a worker',
      applicableTo: (a) => typeof a.sentAt === 'number',
      onInvoke: async (sent, ctx) => {
        const ids = sent.map((a) => a.id).filter((id): id is string => !!id)
        await deleteAnnotationsById(ids, ctx.refreshAnnotations)
      },
    },
    {
      id: 'save-as-fiber',
      label: 'Fiber',
      title: 'Save all comments as one fiber',
      onInvoke: (annotations) =>
        saveAnnotationsAsFiber({
          path: args.path,
          originId: args.originId,
          cityId: args.cityId,
          annotations,
        }),
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
      <AdapterProvider adapter={adapter}>
        <FileViewerPage
          path={opts.path}
          originId={opts.originId}
          cacheBust={opts.cacheBust}
          editable={opts.editable}
          jumpToLine={opts.jumpToLine}
        />
      </AdapterProvider>,
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
      <AdapterProvider adapter={adapter}>
        <FileViewerPage
          path={next.path}
          originId={next.originId}
          editable={next.editable}
          jumpToLine={next.jumpToLine}
        />
      </AdapterProvider>,
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
  const unlockBackground = lockModalBackground(container)

  const adapter = createPortolanAdapter({
    cityId: opts.cityId,
    defaultOriginId: opts.originId,
  })

  const close = () => {
    unlockBackground()
    root.unmount()
    container.remove()
  }

  root.render(
    <AdapterProvider adapter={adapter}>
      <FileViewerModal
        path={opts.path}
        originId={opts.originId}
        cityId={opts.cityId}
        editable={opts.editable}
        jumpToLine={opts.jumpToLine}
        headerAnnotationActions={portolanHeaderActions({
          path: opts.path,
          originId: opts.originId ?? 'local',
          cityId: opts.cityId,
        })}
        onClose={close}
      />
    </AdapterProvider>,
  )

  return { close }
}

export interface OpenWorkspaceModalOptions {
  cityId: string
  /** Initial fiber slug to land on. Typically `<cityId>/<cityId>` (the city's root fiber). */
  initialSlug?: string
  originId?: string
  /** Display name shown above IndexView's "Index" cartouche. Typically the
   *  city name (`portolan`, `LightconeResearch`); flows to vellum's
   *  CollectionContext via WorkspaceMount.eyebrow. */
  cityName?: string
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
  // Labelled as a dialog so the a11y tree gets a named handle for the
  // whole modal; otherwise descendants' text concatenates into a
  // giant unnamed generic. See vellum-dogfood/vellum-modal-generic-label.
  container.setAttribute('role', 'dialog')
  container.setAttribute('aria-modal', 'true')
  container.setAttribute('aria-label', 'Vellum workspace')
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1000',
    background: 'var(--porch-panel, #ede8e0)',
    overflow: 'hidden',
  })
  document.body.appendChild(container)
  const root = createRoot(container)
  const unlockBackground = lockModalBackground(container)

  const adapter = createPortolanAdapter({
    cityId: opts.cityId,
    defaultOriginId: opts.originId,
  })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    unlockBackground()
    root.unmount()
    container.remove()
    document.removeEventListener('keydown', onKey, true)
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    // Never swallow Escape while focus is inside a CodeMirror editor — vim
    // needs it to exit insert mode, finish search, cancel completion, etc.
    // Users close the modal via click-outside or the X button in that case.
    const target = event.target
    if (target instanceof Element && target.closest('.cm-editor')) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  document.addEventListener('keydown', onKey, true)

  const mountWith = (initialSlug: string) => {
    if (closed) return
    root.render(
      <AdapterProvider adapter={adapter}>
        <WorkspaceMount initialSlug={initialSlug} eyebrow={opts.cityName} />
      </AdapterProvider>,
    )
  }

  if (opts.initialSlug) {
    mountWith(opts.initialSlug)
  } else {
    // Ask the server which fiber is the city's root, then mount on it.
    // If the lookup fails (network error, no root resolved), mount with an
    // empty slug so vellum lands on its IndexView — a coherent "look around"
    // entry point. The previous fallback was `${cityId}/${cityId}` from when
    // cityId was the slug name; now cityId is an opaque hash (per
    // `/astra/graph rootSlug uses city.name`) so that fallback would form
    // `<hash>/<hash>` and trigger vellum's "Fiber X not found. Is mystra
    // running on port 3100?" error on a server that isn't even mystra.
    resolveCityRootSlug(opts.cityId)
      .then((slug) => mountWith(slug ?? ''))
      .catch(() => mountWith(''))
  }

  return { close }
}

async function resolveCityRootSlug(cityId: string): Promise<string | null> {
  // Use the dedicated /city-root-slug endpoint instead of /astra/graph: the
  // modal only needs rootSlug here, and WorkspaceMount fetches the full graph
  // again itself. See vellum-dogfood/vellum-modal-double-graph-fetch.
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const res = await fetch(`http://${host}:4004/city-root-slug?cityId=${encodeURIComponent(cityId)}`)
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
      root.render(<></>)
      return
    }
    root.render(
      <AdapterProvider adapter={adapter}>
        <FiberCard
          node={cachedNode}
          width={width}
          content={cachedContent ?? undefined}
          onNavigate={currentOpts.onNavigate}
        />
      </AdapterProvider>,
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
    // Width / onNavigate tweak only — re-render with cached content.
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
  const unlockBackground = lockModalBackground(container)

  const adapter = createPortolanStaticAdapter({ staticDataBase: opts.staticDataBase })

  const close = () => {
    unlockBackground()
    root.unmount()
    container.remove()
  }

  root.render(
    <AdapterProvider adapter={adapter}>
      <FileViewerModal
        path={opts.path}
        editable={false}
        jumpToLine={opts.jumpToLine}
        onClose={close}
      />
    </AdapterProvider>,
  )

  return { close }
}
