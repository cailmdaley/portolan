/**
 * Vellum mount seams for portolan.
 *
 * Entry points:
 *
 *   - mountVellumFileViewer(container, …) — raw page mount, used when the
 *     host already owns a container and wants FileViewerPage inside it
 *     (inline panels, debug surfaces).
 *   - openVellumWorkspaceModal({ … }) — full-viewport modal hosting either
 *     a fiber (initialSlug) or a file (initialFilePath, with the workspace's
 *     narrative slot routed to FileViewerPage). The single reading surface
 *     for both fibers and files; opened by map chrome, Find clicks, and
 *     `v`/`k`/`/` hotkeys. See [[constitution-remove-floating-cards]] for
 *     the broader "map = navigation, vellum = reading" framing.
 *
 * Previously also exposed `mountVellumFileSurface` /
 * `mountVellumFiberSurface` for the floating-card pin layer, and
 * `openVellumStaticFileModal()` for the standalone GitHub-Pages tapestry
 * viewer. Both retired alongside the floating-card and tapestry rollups
 * (commit 1f25e71 and predecessors); git history carries the recoverable
 * shape if needed.
 *
 * Everything outside this file stays vanilla TS/Three.js. React only lives
 * inside the React root this file creates — see vellum-in-portolan.
 */

import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  AdapterProvider,
  AnnotationActionsProvider,
  FileViewerPage,
  WorkspaceMount,
  useMode,
  useNavigate,
  type Annotation,
  type AnnotationBulkAction,
  type WorkspaceMountApi,
} from 'vellum'
import 'vellum/css'
import { KanbanModal } from '../ui/KanbanModal'
import { createPortolanAdapter } from './portolan-adapter'
import { openWorkerPicker, type WorkerOption, type WorkerPickerChoice } from './workerPicker'
import { showToast } from '../ui/utils'
import { lockModalBackground } from '../ui/modalBackgroundLock'
import { StashForm, injectStashFormStyles } from './StashForm'
import { FindHost, injectFindHostStyles } from './FindHost'

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

/**
 * KanbanHost — React shell that mounts the vanilla-JS `KanbanModal`
 * inside vellum's workspace slot.
 *
 * Lives inside vellum's MemoryRouter + ModeProvider, so card clicks navigate
 * the host vellum (rather than opening another vellum modal) and flip the
 * active mode back to narrative — the kanban is the action queue, the prose
 * is where you actually read what the agent did.
 *
 * Mounted lazily by FiberPage: only when the user is on the Workspace tab.
 * Tab-away unmounts; re-entry remounts and refetches. The KanbanModal
 * instance is owned per-mount; a fresh instance per visit means there's no
 * stale state to drain when the user changes scope mid-session.
 *
 * cityId === undefined → global scope (the aggregation across all known
 * origins, deduped by realpath; constitution §"Reads come from per-origin
 * fiber-tree snapshots").
 */
function KanbanHost({
  cityId: propCityId,
  cityName: propCityName,
  onOpenWorker,
  onOpenFiberInCity,
  kanbanInitialScope: propInitialScope,
}: {
  cityId?: string
  cityName?: string
  /** Click-handler for a card's running-worker indicator. Threaded down from
   *  `openVellumWorkspaceModal({ onOpenWorker })` — main.ts owns the camera
   *  + kitty-focus state, so this side just forwards the tmux session name. */
  onOpenWorker?: (tmuxSessionName: string) => void
  /**
   * Called when the user clicks a card whose owning city is different from
   * the host vellum's current city (or when the host is global, which has
   * no fiber graph at all). The host (main.ts) closes the current vellum and
   * opens a fresh one scoped to `cityId` with `slug` selected. Without this,
   * a click in the global kanban lands on vellum's "not found" page — the
   * fiber graph is project-scoped but the card.id is loom-relative.
   *
   * Optional: when omitted, the kanban falls back to the legacy
   * `setMode + navigate(/${id})` path which only works for cards that live
   * in the host vellum's collection.
   */
  onOpenFiberInCity?: (cityId: string, slug: string) => void
  /**
   * Initial kanban scope, from URL restore. `'global'` mounts the kanban
   * in global scope even when the modal has a cityId. Undefined = inherit
   * city scope from the modal's cityId. The in-place ⊕ Global flip retired
   * with the thumb-index global-navigation constitution; this prop only
   * carries restore-state now. */
  kanbanInitialScope?: string | 'global'
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const { setMode } = useMode()
  const kanbanRef = useRef<KanbanModal | null>(null)
  // Stash form state. Open via `+` button or `n` hotkey; closes on submit
  // (with kanban refetch) or cancel/esc.
  const [stashOpen, setStashOpen] = useState(false)

  // Effective scope is a derivation of props: the URL-restored
  // `propInitialScope === 'global'` mount in global scope; otherwise
  // inherit the modal's cityId. The previous local-override state for
  // the ⊕ Global button retired with the thumb-index global-navigation
  // constitution — scope flips happen by closing+reopening the modal,
  // so a single derivation is enough.
  const cityId = propInitialScope === 'global' ? undefined : propCityId
  const cityName = cityId === propCityId ? propCityName : undefined

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const kanban = new KanbanModal({
      onOpenFiber: (card) => {
        // Three click paths, in order of preference:
        //
        //   1. Card's owning city matches the host vellum's city — navigate to
        //      the project-relative slug in place. Same behaviour you'd get
        //      from clicking a search result in this collection.
        //   2. Card's owning city differs (or host is global) — pivot vellum
        //      via onOpenFiberInCity. The current modal closes and a fresh
        //      one opens scoped to the card's city with the fiber selected
        //      and Narrative mode active. This is the global-kanban path:
        //      cards from across loom each open in their own city's vellum.
        //   3. Server didn't resolve a city for the card (remote origins,
        //      unpinned felt hosts) — fall back to the legacy navigate. It
        //      will land on "not found" if the slug isn't in the current
        //      collection, but the failure is no worse than today's.
        //
        // Mirrors FloatingIsland's search-result handler: setMode then
        // navigate so the post-paint URL settles on the new fiber inside
        // narrative mode.
        if (card.cityId && card.projectSlug && card.cityId === cityId) {
          setMode('narrative')
          navigate(`/${card.projectSlug}`)
          return
        }
        if (card.cityId && card.projectSlug && onOpenFiberInCity) {
          onOpenFiberInCity(card.cityId, card.projectSlug)
          return
        }
        setMode('narrative')
        navigate(`/${card.id}`)
      },
      // Forward worker-focus to the host (main.ts) — the camera, zoneRenderer
      // and kitty integration live outside the vellum tree, so the host
      // owns the actual focus implementation. Wired through Stage 6's
      // openVellumWorkspaceModal({onOpenWorker}) plumbing.
      onOpenWorker,
      // Header `+` button mirrors the `n` hotkey: both open the StashForm
      // modal owned by this React host. The kanban renders the button in
      // its own header so it's reliably visible regardless of vellum's
      // chrome state (the previous absolute-positioned button at right:380px
      // assumed a thumb-index that doesn't appear on the kanban tab).
      onStashClick: () => setStashOpen(true),
    })
    kanbanRef.current = kanban
    const cityScope =
      cityId !== undefined
        ? { cityId, cityName: cityName ?? cityId }
        : null
    kanban.mount(host, { cityScope })
    injectStashFormStyles()
    return () => {
      kanban.unmount()
      kanbanRef.current = null
    }
  }, [cityId, cityName, navigate, setMode, onOpenWorker, onOpenFiberInCity])

  // Hotkey: `n` opens the stash form. Active whenever KanbanHost is mounted
  // (i.e. the user is on the kanban tab) — vellum tears KanbanHost down on
  // tab-away, so the listener auto-cleans. Ignored when focus is inside an
  // input/textarea/contenteditable (typing 'n' in a text field shouldn't
  // trigger the modal). Capture-phase so we beat KanbanModal's own column-
  // zoom Enter/Space handlers, but they don't bind 'n'. Only `n` (lowercase
  // n only — uppercase, ctrl/cmd+n stay free for "new browser window".)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return
      }
      if (stashOpen) return
      e.preventDefault()
      e.stopPropagation()
      setStashOpen(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [stashOpen])

  // Resolve the cityPath we'll feed to /fiber/create. For a city-scoped
  // host, that's the city's filesystem path (the directory containing
  // `.felt/`). For the global view, return null — StashForm falls back to
  // /kanban's `feltHost` (~/loom) so the global stash lands at the loom
  // monorepo root.
  const resolveCityPath = (): string | null => {
    if (!cityId) return null
    const city = mountContext?.getCities().find((c) => c.id === cityId)
    return city?.path ?? null
  }
  const resolveOriginId = (): string => {
    if (!cityId) return 'local'
    const city = mountContext?.getCities().find((c) => c.id === cityId)
    return city?.originId ?? 'local'
  }

  // Position fixed so the host covers the modal viewport regardless of
  // vellum-page's natural-flow height. z-index: 100 sits below
  // FloatingIsland (500) and the modal close button (1001) so vellum's
  // chrome stays usable on top of the kanban grid. The embedded KanbanModal
  // inside fills `position: absolute; inset: 0` against this host.
  //
  // Stash trigger lives inside KanbanModal's own header now (wired via the
  // `onStashClick` option above). The form modal still sits as a sibling
  // to the kanban DOM inside this host — z 200 with its own scrim, mounted
  // only when `stashOpen` is true.
  return (
    <div
      ref={hostRef}
      className="kanban-host"
      style={{ position: 'fixed', inset: 0, zIndex: 100 }}
    >
      {stashOpen && (
        <StashForm
          cityPath={resolveCityPath()}
          originId={resolveOriginId()}
          availableCities={mountContext?.getCities() ?? []}
          // Per-city activity for recency sort: max(lastActivity) across
          // sessions in each city. Sessions without a cityId are skipped.
          // Computed at form-open time (not memoized) — the picker is
          // short-lived and the session list is small.
          cityActivityById={(() => {
            const map: Record<string, number> = {}
            for (const s of mountContext?.getSessions() ?? []) {
              if (!s.cityId) continue
              if ((map[s.cityId] ?? 0) < s.lastActivity) {
                map[s.cityId] = s.lastActivity
              }
            }
            return map
          })()}
          onCreated={(fiberId) => {
            setStashOpen(false)
            // Refresh kanban so the new fiber appears (it'll only land in
            // a column when constitution-tagged — the visible signal for
            // a non-constitution stash is the toast). Re-call mount() with
            // the same scope: KanbanModal short-circuits to a fetchAndRender
            // when already mounted. A short delay gives the FS time to
            // surface the freshly-written file before the kanban walks the
            // tree (felt's exec returned but a lazy sync can lag); without
            // it the first kanban refresh occasionally misses the new fiber
            // and the user has to flip tabs to see it.
            const refresh = (): void => {
              const k = kanbanRef.current
              if (!k) return
              const cityScope =
                cityId !== undefined
                  ? { cityId, cityName: cityName ?? cityId }
                  : null
              const host = hostRef.current
              if (host) k.mount(host, { cityScope })
            }
            window.setTimeout(refresh, 100)
            // Second refresh slightly later — covers cases where the first
            // walk raced the disk; cheap belt-and-braces.
            window.setTimeout(refresh, 600)
            showToast(`Stashed: ${fiberId}`, 'success', 2500)
          }}
          onCancel={() => setStashOpen(false)}
        />
      )}
    </div>
  )
}

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
    /** Tmux session name — the contract `onOpenWorker(tmuxSession)`
     *  callers downstream (kanban, Find's Cities column workers nest)
     *  use to resolve a worker → kitty tab on click. Mirrors
     *  `state/types.ts:Session.tmuxSession`. */
    tmuxSession: string
    cityId: string | null
    originId: string
    status: 'idle' | 'working'
    /** Unix-ms of the worker's most recent tool event (or session creation
     *  if no tool events yet). Threaded through from `state/types.ts:Session`
     *  so consumers can rank cities/workers by recent activity without
     *  needing to walk back into the full state graph. */
    lastActivity: number
  }>
  getCities: () => Array<{
    id: string
    name?: string
    path: string
    originId: string
    /**
     * Git repository status — populated by `GitStatusManager` and threaded
     * through the WS state-sync. Optional because not every city is in a
     * git repo (and the field may be absent before the first git poll).
     * Used by `FindHost`'s Git section (Stage F of constitution-portolan-
     * navigation-layer) to render branch / diff / last-commit per city
     * without prop-threading. Shape mirrors `state/types.ts:GitStatus` —
     * keep narrow and structural to avoid pulling the full type into
     * vellum's module boundary.
     */
    gitStatus?: {
      branch: string
      ahead: number
      behind: number
      staged: { added: number; modified: number; deleted: number }
      unstaged: { added: number; modified: number; deleted: number }
      untracked: number
      linesAdded: number
      linesRemoved: number
      lastCommitTime: number | null
      lastCommitMessage: string | null
      isRepo: boolean
    }
  }>
  /**
   * Request a directory listing for `(cityId, path)`. Stage E of
   * constitution-portolan-navigation-layer: the Find dashboard's Files
   * column lazy-loads each directory through the WS `listDirectory`
   * protocol. Promise-shaped wrapper lives in
   * `runtime/DirectoryListingClient`; main.ts wires it into the WS pipe
   * (the only consumer post-Stage-I; the pre-Stage-I CityHUDFileTree
   * co-handler retired with the rest of the HUD).
   *
   * Optional: callers (FindHost) degrade to "offline" state when the
   * context's request method isn't installed yet (e.g. before
   * `setPortolanMountContext` runs in `main.ts`).
   */
  requestDirectoryListing?: (cityId: string, path: string) => Promise<{
    entries: Array<{ name: string; type: 'file' | 'dir' }>
    error?: string
  }>
  /**
   * Open a file at `path` (absolute) in vellum's file mode. Wraps the
   * portolan `openFile()` helper so FindHost can route a Files-column
   * click without re-implementing the workspace-modal hand-off. Optional;
   * if absent, FindHost falls back to a console warning.
   */
  openFile?: (args: {
    path: string
    originId?: string
    cityId?: string
    jumpToLine?: number
  }) => void
  /**
   * Stage G of constitution-portolan-navigation-layer. Record a single
   * vellum view in the SQLite-backed recents store (via POST
   * /recents/touch). The Recents column in FindHost reads back through
   * `getRecents`. Optional; absence is tolerated (Recents column
   * degrades to empty).
   *
   * `kind` partitions fibers from files; `path` is the fiber slug for
   * fibers, the city-relative path for files (matches how the server
   * stores agent file-touches — see server's `relativeToCity`).
   */
  recordRecentView?: (args: {
    kind: 'fiber' | 'file'
    path: string
    cityId: string
    originId?: string
  }) => void
  /**
   * Stage G of constitution-portolan-navigation-layer. Fetch top-N
   * rolled-up recent views (across humans + agents) for the given
   * scope. Pass `cityId` to scope; omit for global.
   */
  getRecents?: (args: {
    cityId?: string
    limit?: number
  }) => Promise<RecentEntry[]>
}

/**
 * Mirror of server's RecentEntry — kept narrow on the client side so the
 * FindHost RecentsSection doesn't need to import server types. Server
 * truth lives in `server/src/RecentsStore.ts`.
 */
export interface RecentEntry {
  originId: string
  cityId: string
  kind: 'fiber' | 'file'
  path: string
  lastViewedAt: number
  viewCount: number
  viewerKinds: Array<'human' | 'agent'>
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
 * Read-only accessor for sibling vellum-mount components (e.g. `FindHost`)
 * that need to resolve city/session metadata without prop-threading. Returns
 * `null` until `setPortolanMountContext` runs — callers should degrade
 * gracefully (empty city name, "?" hostname) when the context isn't ready.
 *
 * Kept narrow on purpose: the same object that flows through
 * `setPortolanMountContext` so consumers see live values across state-sync
 * pushes (the closures inside `mountContext` read the latest `cities`/
 * `sessions` arrays at call time).
 */
export function getPortolanMountContext(): PortolanMountContext | null {
  return mountContext
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
 * Fiber-bound counterpart to `sendAnnotationsToChoice`. Same picker flow and
 * server route (/send-annotations); the server detects `fiberSlug` in the
 * body and formats the worker prompt with a fiber-shaped header instead of
 * a file path. Annotations are persisted with `filePath = slug` (portolan's
 * adapter convention), so reusing the same endpoint and persistence keying
 * is safe.
 */
async function sendFiberAnnotationsToChoice(args: {
  slug: string
  originId: string
  cityId: string | undefined
  annotations: Annotation[]
  choice: WorkerPickerChoice
  refreshAnnotations: () => void
}): Promise<void> {
  const body: Record<string, unknown> = {
    // The annotation persistence key for fiber annotations IS the slug —
    // portolan's adapter sets `filePath: input.filePath ?? input.slug` on
    // create. Pass the slug as both filePath (for sentAt-marking lookups
    // server-side) and fiberSlug (so the prompt header reads "fiber: <slug>"
    // instead of treating the slug as a file path).
    filePath: args.slug,
    fiberSlug: args.slug,
    annotations: args.annotations,
  }

  if (args.choice.kind === 'existing') {
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
    // New worker lives in the CURRENT fiber's city. Without an explicit
    // cityPath the server falls back to deriving cwd from filePath, which
    // for a slug like `card-redesign/x` would be `card-redesign` — not a
    // real directory. Pass the resolved city.path so the new worker spawns
    // in the project root.
    const city = resolveCity(args.cityId, args.originId)
    body.originId = args.originId
    body.createNewWorker = true
    if (city?.path) body.cityPath = city.path
  }

  const ok = await postSendAnnotations(body)
  if (ok) args.refreshAnnotations()
}

/**
 * Save annotations as a *child* fiber under the current slug. The no-worker
 * fallback for fiber-mode: capture the thought in place. The server's
 * /file-as-fiber endpoint accepts `parentSlug` and nests the new fiber as
 * `<parentSlug>/<derivedChildSlug>`.
 */
async function saveFiberAnnotationsAsChildFiber(args: {
  parentSlug: string
  originId: string
  cityId: string | undefined
  annotations: Annotation[]
}): Promise<void> {
  const { parentSlug, originId, cityId, annotations } = args
  if (annotations.length === 0) return
  const parentLeaf = parentSlug.split('/').pop() ?? parentSlug
  const title =
    annotations.length === 1
      ? `Note on ${parentLeaf}`
      : `${annotations.length} notes on ${parentLeaf}`

  // Body: fiber identifier on top, then per-annotation quote + comment.
  // Mirrors saveAnnotationsAsFiber's prose shape so a child note reads
  // consistently with a top-level file-derived note.
  const sections: string[] = [`See [[${parentSlug}]].`, '']
  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i]
    const header = annotations.length === 1 ? '' : `## ${i + 1}.`
    if (header) sections.push(header)
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
      // /file-as-fiber requires filePath in its current shape; use the
      // parent slug as the placeholder identifier. cityPath is what
      // actually drives the felt invocation, not filePath, so this is
      // harmless. parentSlug is what makes the new fiber land as a child.
      filePath: parentSlug,
      originId,
      cityPath,
      title,
      body: sections.join('\n'),
      kind: 'note',
      parentSlug,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[annotation-actions] save-as-child-fiber failed', res.status, detail)
    showToast('Save as fiber failed', 'error')
    return
  }
  const result = await res.json().catch(() => ({} as { fiberId?: string }))
  showToast(
    result.fiberId ? `Filed as ${result.fiberId}` : 'Filed as child fiber',
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
      // Nuclear option — clear every annotation on this file regardless
      // of sent state. Confirms first because the action is irreversible
      // and easy to mis-click against a dense margin. Uses window.confirm
      // for now; can graduate to an inline confirm popover if the gesture
      // proves too jarring.
      id: 'clear-all',
      label: 'Clear',
      destructive: true,
      title: 'Delete all comments on this file',
      onInvoke: async (annotations, ctx) => {
        const n = annotations.length
        const noun = n === 1 ? 'comment' : 'comments'
        if (!window.confirm(`Delete all ${n} ${noun} on this file? This can't be undone.`)) return
        const ids = annotations.map((a) => a.id).filter((id): id is string => !!id)
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

/**
 * Fiber-bound bulk actions for the workspace's narrative view. Mirrors
 * `portolanHeaderActions` (Send / Clear sent / Fiber) but binds to a fiber
 * slug instead of a file path. The slug isn't known at registration time
 * (the user navigates between fibers within one workspace mount); each
 * action reads `ctx.currentSlug` at invoke time, threaded through by
 * `NarrativeAnnotationActionsBar`.
 *
 * Send → resolves slug → fiber body file path on the server side, sends
 *        the prompt with a fiber-shaped header.
 * Clear sent → identical to the file path (annotation IDs are global).
 * Fiber → saves the annotations as a *child* of the current fiber. This
 *         is the no-worker fallback the user named explicitly: when you
 *         want to record a comment but don't have a worker to send it to,
 *         the comment lands as a child fiber under the current slug.
 */
function portolanFiberBulkActions(args: {
  cityId?: string
  originId: string
}): AnnotationBulkAction[] {
  return [
    {
      id: 'send-to-worker',
      label: 'Send',
      title: 'Send comments to a worker',
      onInvoke: (annotations, ctx) => {
        const slug = ctx.currentSlug
        if (!slug) return
        const workers = listAllWorkers()
        const city = resolveCity(args.cityId, args.originId)
        openWorkerPicker({
          anchor: ctx.anchor,
          workers,
          currentCityId: args.cityId ?? null,
          currentProjectLabel: city?.name ?? 'project',
          onPick: (choice) => {
            void sendFiberAnnotationsToChoice({
              slug,
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
      // Nuclear option for fiber mode — symmetric with the file-mode
      // variant in `portolanHeaderActions`. Confirms first; the bar's
      // count badge reflects just this fiber's annotations (the
      // currentSlug filter), so the prompt's number matches what the
      // user sees.
      id: 'clear-all',
      label: 'Clear',
      destructive: true,
      title: 'Delete all comments on this fiber',
      onInvoke: async (annotations, ctx) => {
        const n = annotations.length
        const noun = n === 1 ? 'comment' : 'comments'
        if (!window.confirm(`Delete all ${n} ${noun} on this fiber? This can't be undone.`)) return
        const ids = annotations.map((a) => a.id).filter((id): id is string => !!id)
        await deleteAnnotationsById(ids, ctx.refreshAnnotations)
      },
    },
    {
      id: 'save-as-child-fiber',
      label: 'Fiber',
      title: 'Save all comments as a child fiber under this one',
      onInvoke: (annotations, ctx) => {
        const slug = ctx.currentSlug
        if (!slug) return
        return saveFiberAnnotationsAsChildFiber({
          parentSlug: slug,
          originId: args.originId,
          cityId: args.cityId,
          annotations,
        })
      },
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

/**
 * Public mode names used by portolan callers. Translates to vellum's internal
 * `Mode` ('workspace' instead of 'kanban') at the boundary in
 * `openVellumWorkspaceModal`. `'find'` is portolan's name for vellum's
 * (identically-named) Find tab — no translation needed; included here to keep
 * the public-facing union aligned with what callers see in the UI.
 */
export type VellumModalMode = 'narrative' | 'kanban' | 'find' | 'delta'

export interface VellumModalHandle {
  close(): void
  /** Flip to a different tab without re-opening the modal. Used by the global
   *  `k` hotkey to land an open vellum on Kanban in place. No-op until the
   *  React tree has mounted (a brief race on first render); callers can rely
   *  on the next call settling once mount completes. */
  setMode(mode: VellumModalMode): void
  /** Read the current mode. Returns `'narrative'` until first mount. */
  getMode(): VellumModalMode
}

// openVellumFileModal retired 2026-04-25 — files now route through
// openVellumWorkspaceModal({ initialFilePath, … }), which lands on
// FileViewerPage in the workspace's narrative slot. See
// card-redesign/file-modal-absorbs-into-workspace.

export interface OpenWorkspaceModalOptions {
  /** City context for fiber operations (graph fetch, search, fiber content).
   *  Required for fiber mode; optional in file mode (the adapter degrades:
   *  no fiber graph, no search — but the file path stands on its own). */
  cityId?: string
  /** Initial fiber slug to land on. Typically `<cityId>/<cityId>` (the city's root fiber).
   *  Mutually exclusive with `initialFilePath`. */
  initialSlug?: string
  originId?: string
  /** Display name shown above IndexView's "Index" cartouche. Typically the
   *  city name (`portolan`, `LightconeResearch`); flows to vellum's
   *  CollectionContext via WorkspaceMount.eyebrow. */
  cityName?: string
  /** Open the workspace in *file mode* — FileViewerPage in the narrative slot,
   *  Workspace + Delta tabs disabled. Mutually exclusive with `initialSlug`.
   *  Replaces the standalone openVellumFileModal: see card-redesign/file-modal-absorbs-into-workspace. */
  initialFilePath?: string
  /** When true and `initialFilePath` is text/markdown, the file opens in the
   *  editor with Save in the file-mode toolbar. Ignored unless `initialFilePath` is set. */
  editable?: boolean
  /** 1-indexed line to jump to when the file opens. Ignored unless `initialFilePath` is set. */
  jumpToLine?: number
  /** Tab to land on at first paint. `'narrative'` (default) opens on the prose;
   *  `'kanban'` deep-links to the (slot-overridden) Workspace tab so the user
   *  sees the kanban grid immediately — used by the global launch button and
   *  the city HUD's kanban affordance once Stage 6 retargets them.
   *  `'find'` deep-links to the Find tab (used by the `/` hotkey's scope
   *  ladder; see [[ai-futures/portolan/design/constitution-portolan-navigation-layer]]).
   *  `'delta'` for completeness. Ignored in file mode (locked to narrative). */
  initialMode?: VellumModalMode
  /** Click-handler for a card's running-worker indicator inside the embedded
   *  kanban. The host (main.ts) owns the map camera, zone renderer and kitty
   *  focus — the kanban just forwards the tmux session name when the user
   *  clicks the indicator. Optional; if omitted the indicator is informational
   *  only. */
  onOpenWorker?: (tmuxSessionName: string) => void
  /** Click-through for a kanban card whose owning city differs from this
   *  modal's `cityId` (or when this modal is global). The host closes the
   *  current vellum and opens a fresh one scoped to the card's city with
   *  the fiber selected. Without this, the global-kanban click path lands
   *  on vellum's "not found" page because the loom-relative card id isn't
   *  in any project-scoped collection. */
  onOpenFiberInCity?: (cityId: string, slug: string) => void
  /** Stage J of `constitution-portolan-navigation-layer` — initial Find
   *  scope override. When undefined (default), Find scope inherits from
   *  the modal's `cityId`. When set to a cityId or the literal `'global'`,
   *  FindHost mounts with that scope instead. Used by the URL applier on
   *  reload-restore to land on `&scope=…` deep links faithfully. */
  findInitialScope?: string | 'global'
  /** Stage J — fired when the user re-scopes Find in place via the
   *  Cities-column click (specific cityId, or `null` from the "All
   *  cities" pseudo-row / de-toggle on the active scoped row). Lets the
   *  host mirror the new scope into the URL fragment so reload restores
   *  it. `null` ⇒ explicit clear, `string` ⇒ specific cityId,
   *  `undefined` ⇒ scope inherits from modal cityId. The eyebrow's
   *  in-place ⊕ Global button retired with the thumb-index
   *  global-navigation constitution. */
  onFindScopeChange?: (scopeCityId: string | null | undefined) => void
  /**
   * Initial scope for the kanban tab, analogous to `findInitialScope`.
   * When `'global'`, KanbanHost mounts with global scope even when
   * the modal has a cityId (used by URL restore to honour
   * `&scope=global&mode=kanban`). Undefined means inherit from modal
   * cityId (city-scoped). The in-place ⊕ Global flip retired with the
   * thumb-index global-navigation constitution; this option only carries
   * URL-restore state now. */
  kanbanInitialScope?: string | 'global'
  /** Fired exactly once when the modal closes (Escape key, click on the
   *  ×, programmatic `handle.close()`). Lets the host reset its tracking
   *  state — without this, `activeWorkspaceHandle` becomes a stale
   *  reference after Escape and subsequent hotkeys (`/` ladder, `k` chord)
   *  silently no-op against a torn-down React tree. Idempotent: only ever
   *  called for the first close; later close() invocations short-circuit. */
  onClose?: () => void
  /**
   * Fired when the user clicks the thumb-index `← index` button while
   * sitting at this collection's root (a fiber with no parent). Lets
   * portolan promote the click into an escape upward — typically by
   * closing this modal and opening a fresh global-scope vellum on the
   * synthetic loom-wide collection. Wired by city-scoped opens
   * (`openCityWorkspace`, `openGlobalKanban`, `openGlobalFind`); omitted
   * for the global-Vellum mount itself so its top-level `← index` button
   * stays idempotent (falls back to vellum's local `navigate('')`, which
   * the global graph has no rootSlug to redirect away from). See
   * [[ai-futures/portolan/vellum-reader/constitution-thumb-index-global-navigation]].
   */
  onIndexEscalate?: () => void
  /**
   * Fired when the user clicks any synthetic-slug node (slug starting
   * with `__`). Used by the global Vellum mount to remount in city
   * scope when the user clicks a `__city__:cityId` city node, so the
   * destination city's full graph and thumb-index load instead of the
   * city's root narrative being shoehorned into the global mount with
   * the cities-only graph still active. The host receives the raw slug
   * (e.g. `__city__:portolan`) and is responsible for parsing and
   * dispatching. Wired only by the global-mount opener; city-scoped
   * mounts have no synthetic nodes in their local graph.
   */
  onOpenSyntheticNode?: (slug: string) => void
}

/**
 * Full-viewport vellum workspace modal for a portolan city. Mounts
 * vellum's WorkspaceMount (narrative / workspace / delta modes) against
 * the PortolanAdapter for the given city. Opens on `t` / deep-press / city
 * click; the single reading surface for both fibers and files.
 *
 * Two opening modes:
 *   - `initialSlug` (default): land on a fiber. The historical mode.
 *   - `initialFilePath`: land in *file mode*. FiberPage routes the narrative
 *     slot to FileViewerPage; Workspace + Delta tabs are disabled because
 *     they're fiber-collection concepts. Replaces openVellumFileModal —
 *     see card-redesign/file-modal-absorbs-into-workspace.
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
  // tabindex="-1" so we can programmatically focus the container after
  // mount: without focus inside the scrollable region, arrow-key
  // scrolling is a no-op because the document body has no overflow to
  // scroll. -1 keeps the container out of the tab cycle while still
  // being a valid focus target for `.focus()`.
  container.tabIndex = -1
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1000',
    background: 'var(--porch-panel, #ede8e0)',
    // `overflow: auto` (not hidden) so the prose column can scroll on
    // long fibers. The standalone vellum app relies on document scroll;
    // here the modal is its own scroll container because <body> is
    // locked behind the modal background. Vellum's fixed chrome
    // (FloatingIsland, thumb-index, CanvasDivider) is `position: fixed`
    // and stays anchored to the viewport while the prose scrolls under
    // it. See vellum-dogfood/vellum-workspace-modal-no-scroll.
    overflow: 'auto',
    // Suppress the focus ring that would otherwise show on the whole
    // viewport-sized container when we focus it for keyboard scroll.
    outline: 'none',
  })
  document.body.appendChild(container)

  // React mounts into its own child div so we can keep portolan-owned
  // chrome (the close button) as a sibling: createRoot() takes ownership
  // of its container's children and would wipe any DOM we appended to
  // `container` directly on every render.
  const reactHost = document.createElement('div')
  container.appendChild(reactHost)
  const root = createRoot(reactHost)
  const unlockBackground = lockModalBackground(container)

  // Visible escape hatch — Escape works, but a button is what every other
  // user expects. Sits in the leftmost position of vellum's file-mode
  // toolbar (or above the thumb-index header in narrative mode) so it
  // shares the chrome's vertical rhythm with the file path / fiber title
  // and the action group on the right. The toolbar's padding-left is
  // bumped via a sibling stylesheet rule (index.html) so the path text
  // flows past the button instead of underneath it. Quiet at rest —
  // border only on hover/focus — so it reads as chrome, not a CTA.
  // See vellum-dogfood/vellum-workspace-modal-no-close-button.
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'vellum-workspace-modal-close'
  closeBtn.setAttribute('aria-label', 'Close vellum workspace (Esc)')
  closeBtn.title = 'Close (Esc)'
  closeBtn.textContent = '×'
  Object.assign(closeBtn.style, {
    position: 'fixed',
    // Workspace modal's three top elements — close button (here), the
    // file-mode toolbar's path text, and the thumb-index header — share
    // a single horizontal centreline. The portolan-injected CSS in
    // index.html pads the toolbar to padding 14px y (toolbar ≈ 53px
    // tall) and tightens the thumb-index padding-top to 10px so its
    // first row of mode tabs centres at the same y. Centre the 24px
    // button on that band: top = (53 − 24)/2 ≈ 14. See
    // vellum-reader/modal-chrome-alignment and
    // vellum-reader/title-bar-thumb-index-alignment.
    top: '14px',
    left: '8px',
    zIndex: '1001',
    width: '24px',
    height: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid transparent',
    borderRadius: '4px',
    background: 'transparent',
    color: 'var(--text-muted, #7A7368)',
    cursor: 'pointer',
    fontSize: '17px',
    lineHeight: '1',
    fontFamily: 'inherit',
    padding: '0',
    transition: 'background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out',
  })
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = 'rgba(160, 48, 48, 0.10)'
    closeBtn.style.borderColor = 'rgba(160, 48, 48, 0.32)'
    closeBtn.style.color = '#A03030'
  })
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = 'transparent'
    closeBtn.style.borderColor = 'transparent'
    closeBtn.style.color = 'var(--text-muted, #7A7368)'
  })
  closeBtn.addEventListener('click', () => close())
  container.appendChild(closeBtn)

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
    // Notify the host so it can clear its own bookkeeping (e.g. portolan's
    // `activeWorkspaceHandle` / `activeWorkspaceCityId`). Wrapped in
    // try/catch because a host throw mid-close would leave the modal half-
    // dismantled — better to log and continue.
    if (opts.onClose) {
      try {
        opts.onClose()
      } catch (err) {
        console.error('[vellum-modal] onClose handler threw:', err)
      }
    }
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    // Never swallow Escape while focus is inside a CodeMirror editor — vim
    // needs it to exit insert mode, finish search, cancel completion, etc.
    // Users close the modal via click-outside or the X button in that case.
    const target = event.target
    if (target instanceof Element && target.closest('.cm-editor')) return
    // Skip when an inline stash form is mounted — Esc should close the
    // form, not unwind the whole vellum modal underneath it.
    // (constitution-stash-button) The form's own React onKeyDown handles
    // the close; we just stay out of its way.
    if (document.querySelector('.stash-scrim')) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  document.addEventListener('keydown', onKey, true)

  const focusContainer = () => {
    // Move focus into the modal so arrow keys scroll the container
    // immediately. Without this, the user has to click into the prose
    // first; in particular trackpad/mouse-wheel works without focus but
    // arrow-key scrolling does not (the body is inert behind the modal,
    // so there's no fallback focus root the browser can scroll).
    queueMicrotask(() => {
      if (closed) return
      container.focus({ preventScroll: true })
    })
  }

  // Fiber-bound bulk actions for narrative view. The slug isn't pinned at
  // registration time — vellum threads `currentSlug` through the bar's ctx
  // so each invocation knows which fiber it's on. Computed once per modal
  // mount (cityId/originId are stable) and provided via
  // AnnotationActionsProvider for vellum's NarrativeAnnotationActionsBar.
  const fiberBulkActions = portolanFiberBulkActions({
    cityId: opts.cityId,
    originId: opts.originId ?? 'local',
  })

  // Vellum's 'workspace' tab is the slot vellum-kanban embeds into. The
  // public-facing initialMode says 'kanban' (honest naming for portolan
  // users); translate to vellum's internal mode id here. 'delta', 'narrative',
  // and 'find' pass through unchanged.
  const internalFromPublic = (m: VellumModalMode) =>
    m === 'kanban'
      ? ('workspace' as const)
      : (m as 'narrative' | 'find' | 'delta')
  const publicFromInternal = (
    m: 'narrative' | 'workspace' | 'find' | 'delta',
  ): VellumModalMode => (m === 'workspace' ? 'kanban' : m)
  const initialVellumMode = internalFromPublic(opts.initialMode ?? 'narrative')

  // Bridge captured from <WorkspaceMount apiRef={…}/> on first React commit.
  // Stays null while file mode is mounted (no apiRef passed there, since
  // Workspace + Delta are disabled). setMode/getMode degrade gracefully when
  // null so the global `k` hotkey doesn't blow up between mounts.
  let api: WorkspaceMountApi | null = null
  const captureApi = (next: WorkspaceMountApi | null) => {
    api = next
  }

  // The kanban slot is constructed once per modal open and threaded through
  // every fiber-mode render so the user can flip to the Kanban tab at any
  // time. cityId === undefined → global aggregation. The slot is React: a
  // host div that mounts an embedded KanbanModal on first render and
  // unmounts on tab change. See `vellum-reader/constitution-vellum-kanban`
  // §"Stage 5".
  const kanbanSlot = (
    <KanbanHost
      cityId={opts.cityId}
      cityName={opts.cityName}
      onOpenWorker={opts.onOpenWorker}
      onOpenFiberInCity={opts.onOpenFiberInCity}
      kanbanInitialScope={opts.kanbanInitialScope}
    />
  )
  // The find slot mirrors the kanban slot's shape: vellum lazy-mounts on
  // tab-enter, portolan owns the body. Stage A (shell only) → Stage B
  // (cross-project Fibers tree from /global-fibers); Stages C/D/E/F/G
  // bring the rest of the dashboard sections per
  // [[ai-futures/portolan/design/constitution-portolan-navigation-layer]].
  injectFindHostStyles()
  const findSlot = (
    <FindHost
      cityId={opts.cityId}
      cityName={opts.cityName}
      onOpenWorker={opts.onOpenWorker}
      onOpenFiberInCity={opts.onOpenFiberInCity}
      initialScope={opts.findInitialScope}
      onScopeChange={opts.onFindScopeChange}
    />
  )

  const mountWith = (initialSlug: string) => {
    if (closed) return
    root.render(
      <AdapterProvider adapter={adapter}>
        <AnnotationActionsProvider bulkActions={fiberBulkActions}>
          <WorkspaceMount
            initialSlug={initialSlug}
            eyebrow={opts.cityName}
            onIndexEscalate={opts.onIndexEscalate}
            onOpenSyntheticNode={opts.onOpenSyntheticNode}
            initialMode={initialVellumMode}
            workspaceSlot={kanbanSlot}
            workspaceLabel="Kanban"
            workspaceLetter="K"
            findSlot={findSlot}
            findLabel="Find"
            findLetter="F"
            apiRef={captureApi}
          />
        </AnnotationActionsProvider>
      </AdapterProvider>,
    )
    focusContainer()
  }

  const mountWithFile = (path: string) => {
    if (closed) return
    root.render(
      <AdapterProvider adapter={adapter}>
        <WorkspaceMount
          initialFilePath={path}
          originId={opts.originId}
          editable={opts.editable}
          jumpToLine={opts.jumpToLine}
          eyebrow={opts.cityName}
          headerAnnotationActions={portolanHeaderActions({
            path,
            originId: opts.originId ?? 'local',
            cityId: opts.cityId,
          })}
        />
      </AdapterProvider>,
    )
    focusContainer()
  }

  if (opts.initialFilePath) {
    // File mode wins — same precedence as WorkspaceMount itself. Skips the
    // city-root resolution because file mode doesn't depend on a slug.
    mountWithFile(opts.initialFilePath)
  } else if (opts.initialSlug) {
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

  return {
    close,
    setMode: (mode) => api?.setMode(internalFromPublic(mode)),
    // Default to 'narrative' before first mount or in file mode (no apiRef
    // is wired there — the kanban tab is suppressed). Reads via the api so
    // post-mount callers see the latest committed mode.
    getMode: () =>
      api ? publicFromInternal(api.getMode()) : (opts.initialMode ?? 'narrative'),
  }
}

async function resolveCityRootSlug(cityId: string | undefined): Promise<string | null> {
  if (!cityId) return null
  // Use the dedicated /city-root-slug endpoint instead of /astra/graph: the
  // modal only needs rootSlug here, and WorkspaceMount fetches the full graph
  // again itself. See vellum-dogfood/vellum-modal-double-graph-fetch.
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const res = await fetch(`http://${host}:4004/city-root-slug?cityId=${encodeURIComponent(cityId)}`)
  if (!res.ok) return null
  const data = await res.json()
  return typeof data.rootSlug === 'string' ? data.rootSlug : null
}
