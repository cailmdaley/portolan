// main.ts - Bootstrap and render loop

import {
  Scene,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Color,
} from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { HexGrid } from './render/HexGrid'
import { ZoneRenderer } from './render/ZoneRenderer'
import { Camera } from './render/Camera'

// Vellum is the file/fiber reading surface; map clicks open it as a modal.
// Lazy-imported so the vendored bundle isn't pulled into the initial paint.
// See [[constitution-remove-floating-cards]] — fiber-level content lives in
// vellum, not as a floating card on the map.
const vellumMountPromise = import('./vellum/mount')
import type { VellumModalHandle } from './vellum/mount'
import { MapInteractionController } from './MapInteractionController'
import { FrontendMapActions } from './FrontendMapActions'
import { installFrontendRuntimeDiagnostics } from './runtime/FrontendRuntimeDiagnostics'
import { getActivitySessionKey } from './runtime/FrontendActivityStore'
import { FrontendStateSync, readUrlCityId, readUrlFiberSlug } from './runtime/FrontendStateSync'
import { FrontendAppRuntime } from './runtime/FrontendAppRuntime'
import { CityHUD } from './ui/CityHUD'
import { ContextMenu } from './ui/ContextMenu'
import { PlaygroundViewer } from './ui/PlaygroundViewer'
import { NewWorkerDialog } from './ui/NewWorkerDialog'
import { GlobalSearchPalette } from './ui/GlobalSearchPalette'
import { KanbanLaunchButton } from './ui/KanbanLaunchButton'
import { RecentWorkerBar } from './ui/RecentWorkerBar'
import { clearArtifactMediaCaches, getArtifactMediaCacheStats } from './ui/ArtifactMedia'
import type { City, Session, ServerOrigin } from './state/types'
import { findBestMatchingCity, findNearestCity } from './state/cityLookup'
import { PALETTE } from './state/types'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const canvasOverlay = canvas

// Setup renderer
const renderer = new WebGLRenderer({
  canvas,
  antialias: true,
})
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(new Color(PALETTE.bgPrimary))
renderer.shadowMap.enabled = true

// CSS2D renderer for HTML labels (small caps, petite caps)
const labelRenderer = new CSS2DRenderer()
labelRenderer.setSize(window.innerWidth, window.innerHeight)
labelRenderer.domElement.style.position = 'absolute'
labelRenderer.domElement.style.top = '0'
labelRenderer.domElement.style.left = '0'
labelRenderer.domElement.style.pointerEvents = 'none'
labelRenderer.domElement.style.userSelect = 'none'
// CSS2DRenderer assigns each label a per-frame z-index from its camera depth
// (range roughly 0..100000). Confine that range with `isolation: isolate` so
// CSS2D labels stay below HUD panels and modals; without it, labels from
// neighbouring cities would punch up through anything stacked above the map.
labelRenderer.domElement.style.zIndex = '10'
labelRenderer.domElement.style.isolation = 'isolate'
labelRenderer.domElement.classList.add('label-container')
document.body.appendChild(labelRenderer.domElement)

// Setup scene
const scene = new Scene()

// Lighting - warm desert sun
const ambientLight = new AmbientLight(0xffeedd, 0.6)
scene.add(ambientLight)

const directionalLight = new DirectionalLight(0xfff5e1, 0.8)
directionalLight.position.set(10, 20, 5)
directionalLight.castShadow = true
directionalLight.shadow.mapSize.width = 2048
directionalLight.shadow.mapSize.height = 2048
directionalLight.shadow.camera.near = 1
directionalLight.shadow.camera.far = 50
directionalLight.shadow.camera.left = -20
directionalLight.shadow.camera.right = 20
directionalLight.shadow.camera.top = 20
directionalLight.shadow.camera.bottom = -20
scene.add(directionalLight)

// Setup hex grid (size 50 = radius of 50 hexes, hexRadius 1.0)
// hexRadius = 1/sqrt(3) makes adjacent hex centers exactly 1 world unit apart
const hexGrid = new HexGrid(100, 1 / Math.sqrt(3))

// Setup camera (use overlay for events - Safari compatibility)
const camera = new Camera(canvas, canvasOverlay)

// Setup zone renderer
const zoneRenderer = new ZoneRenderer(scene, hexGrid)

// Last city the user landed on (sprite click, label click, hash nav, deep
// link). Used for hotkey fallbacks (`t` after the HUD has been hidden) and
// nothing else — there's no per-city pin set to load anymore so the concept
// has narrowed from "pinned city" to "most-recently-focused city."
let lastFocusedCityId: string | null = null

// Wire up worker label click handlers (CSS2D labels need direct handlers)
zoneRenderer.setWorkerClickHandler((workerId, _tmuxSession) => {
  mapActions?.focusKittyTab(workerId)
})

zoneRenderer.setWorkerDblClickHandler((workerId, _tmuxSession) => {
  mapActions?.focusKittyTab(workerId)
})

// Right-click on a worker → focus its kitty tab. The "pin terminal" affordance
// retired alongside floating-card removal — see
// [[constitution-remove-floating-cards]]. Live worker view = bird click /
// context-menu Focus → kitty tab; no in-map tmux mirror.
zoneRenderer.setWorkerContextMenuHandler((workerId, _tmuxSession, clientX, clientY) => {
  contextMenu.show(clientX, clientY, [
    {
      label: 'Focus Worker',
      action: () => mapActions?.focusKittyTab(workerId),
    },
  ])
})

// Wire up worker label hover → file tooltip (same as bird hover but triggered from CSS2D label)
zoneRenderer.setWorkerLabelHoverHandlers(
  (workerId, _tmuxSession, anchor) => {
    const session = sessions.find(s => s.id === workerId)
    if (session) {
      zoneRenderer.updateWorkerFileHover(session, anchor)
    }
  },
  () => {
    zoneRenderer.clearWorkerFileHover()
  }
)

// Wire up city label click handler (needed for remote cities without sprites)
// Uses handleCityClick defined below (after cityPanel initialization)
zoneRenderer.setCityLabelClickHandler((cityId) => {
  const city = cities.find(c => c.id === cityId)
  if (city) handleCityClick(city)
})

// Provide camera's screen-to-world conversion for accurate drag
zoneRenderer.setScreenToWorldConverter((x, y) => camera.screenToWorld(x, y))

// Setup city HUD (corner-anchored widgets, replaces CityPanel)
const cityPanel = new CityHUD()

// Resolve a URL city token (`#city=X` / `?city=X`) to a City. Tokens are
// either opaque ids (from copy-link affordances) or human-readable names (what
// the user types and what the HUD shows). Match by id first, then by name,
// preferring a name with active sessions when two cities share it (the
// local + remote case from `2d9c75d`). Returns null when nothing matches.
// Used by InitialFocus (cold load) and the hashchange listener (mid-session
// hash navigation). See `hash-restore-does-not-select-city`.
function resolveCityFromUrlId(urlCityId: string): City | null {
  const byId = cities.find(c => c.id === urlCityId)
  if (byId) return byId
  const byName = cities.filter(c => c.name === urlCityId)
  if (byName.length === 0) return null
  if (byName.length === 1) return byName[0]
  return byName.find(c =>
    sessions.some(s => s.cityId === c.id && s.lastActivity > 0),
  ) ?? byName[0]
}

// Shared handler for city clicks (used by sprite click and label click)
function handleCityClick(city: City): void {
  selectedHex = city.hex
  lastFocusedCityId = city.id

  // Focus on city and zoom to detail level
  const pos = hexGrid.axialToCartesian(city.hex)
  camera.focusAndZoom(pos, 6, 0.95)

  if (city.isDormant && city.originId !== 'local') {
    void mapActions?.activateRemoteCity(city)
  } else {
    cityPanel.show(city)
    cityPanel.updateWorkers(sessions)
  }
}

// Vellum is the file viewer. Files open in the workspace modal in *file mode*
// — FileViewerPage in the narrative slot, Workspace + Delta tabs disabled.
// The standalone openVellumFileModal has been retired in favor of routing
// every file through the same workspace shell that hosts fibers; see
// card-redesign/file-modal-absorbs-into-workspace.

interface OpenFileArgs {
  path: string
  originId?: string
  cityId?: string
  jumpToLine?: number
  editable?: boolean
}

function openFile(args: OpenFileArgs): void {
  // File mode is single-instance, same lifecycle as the fiber-side workspace.
  // Reuse the workspace open-token so a rapid file-then-fiber sequence (or
  // vice versa) keeps only the latest modal mounted.
  activeWorkspaceHandle?.close()
  activeWorkspaceHandle = null
  activeWorkspaceCityId = args.cityId ?? null
  const myToken = ++workspaceOpenToken
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    if (myToken !== workspaceOpenToken) return
    const handle = openVellumWorkspaceModal({
      cityId: args.cityId,
      originId: args.originId,
      initialFilePath: args.path,
      // Read-mode default: markdown lands in the canvas (PretextProse —
      // same renderer as fiber bodies); other text files render in
      // CodeMirror read-only. Callers that want the source editor up
      // front (e.g. worker prompts that pass jumpToLine for a code file)
      // pass `editable: true` explicitly.
      // See ai-futures/portolan/vellum-reader/markdown-and-fibers-share-canvas.
      editable: args.editable ?? false,
      jumpToLine: args.jumpToLine,
      cityName: args.cityId ? cities.find(c => c.id === args.cityId)?.name : undefined,
      onClose: handleWorkspaceClosed,
    })
    activeWorkspaceHandle = handle
  })
}

// Vellum workspace modal for a city — narrative / workspace / delta / map modes
// against the PortolanAdapter. Single-instance: close the previous handle
// before opening a new city.
let activeWorkspaceHandle: VellumModalHandle | null = null
// The cityId the active vellum is scoped to (null = global / no city). Tracked
// at this level so the `/` hotkey's scope-step ladder (city → global → close)
// can decide whether to escalate scope or just close. Updated alongside every
// openCityWorkspace / openGlobalKanban / openGlobalFind call; cleared on close.
let activeWorkspaceCityId: string | null = null
// Bumped every openCityWorkspace call. The async vellumMountPromise.then()
// callback only mounts if the token is still current — without this guard,
// rapid synchronous calls (mashing `t`, repeated hashchange handlers, …)
// queued multiple `.then()` microtasks that each constructed a fresh modal
// container; only the latest got tracked in `activeWorkspaceHandle`, so the
// rest leaked into the DOM. Reproduced with 5 synchronous `t` keydowns →
// 5 `.vellum-workspace-modal-container` elements remained.
let workspaceOpenToken = 0
/**
 * Ask the server which local city owns a bare fiber slug, used by
 * `#fiber=Y` URL fragments. Returns the matching City from the loaded
 * `cities` array, or null if no local city has the slug. See
 * vellum-dogfood/url-fragment-fiber-nav.
 */
async function resolveFiberCity(slug: string, cities: City[]): Promise<City | null> {
  try {
    const host = window.location.hostname
    const res = await fetch(`http://${host}:4004/fiber-locate?slug=${encodeURIComponent(slug)}`)
    if (!res.ok) return null
    const data = await res.json()
    const cityId: string | undefined = data?.cityId
    if (!cityId) return null
    return cities.find(c => c.id === cityId) ?? null
  } catch {
    return null
  }
}

interface OpenCityWorkspaceOpts {
  initialSlug?: string
  /** Tab to land on at first paint. Defaults to `'narrative'`. The kanban
   *  affordance on the city HUD passes `'kanban'` (Stage 6 retarget — see
   *  vellum-reader/constitution-vellum-kanban). The `/` hotkey passes
   *  `'find'` to land on the Find tab (Stage A of the navigation-layer
   *  constitution). */
  initialMode?: 'narrative' | 'kanban' | 'find' | 'delta'
}

function openCityWorkspace(city: City, opts: OpenCityWorkspaceOpts = {}): void {
  activeWorkspaceHandle?.close()
  activeWorkspaceHandle = null
  activeWorkspaceCityId = city.id
  const myToken = ++workspaceOpenToken
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    // A later openCityWorkspace call already took over — skip mounting so we
    // don't leave an orphan modal container in the DOM next to the one the
    // newer call will mount.
    if (myToken !== workspaceOpenToken) return
    const handle = openVellumWorkspaceModal({
      cityId: city.id,
      originId: city.originId,
      initialSlug: opts.initialSlug,
      initialMode: opts.initialMode,
      // Hand the city name through so vellum's IndexView can label its
      // cartouche correctly. Without this, the eyebrow above "Index"
      // collapses to nothing — honest, but less informative than naming
      // the city we're reading. See vellum's CollectionContext.
      cityName: city.name,
      // Embedded kanban's running-worker indicator → camera focus + kitty tab
      // pivot. Single shared helper so the standalone-modal vs vellum-embedded
      // paths don't drift in their session-resolve logic.
      onOpenWorker: focusWorkerByTmuxSession,
      // City-scoped kanban: cards from another city pivot vellum across.
      // Flipping the kanban tab in the new city would be surprising though —
      // the user clicked through *to* a fiber, so land on its prose.
      onOpenFiberInCity: openFiberInCityFromKanban,
      onClose: handleWorkspaceClosed,
    })
    activeWorkspaceHandle = handle
  })
}

/**
 * Called by `openVellumWorkspaceModal`'s `onClose` callback whenever vellum
 * closes (Escape, ×, programmatic close). Resets host-side bookkeeping —
 * without this, `activeWorkspaceHandle` becomes a stale reference and
 * subsequent hotkeys (`/` ladder, `k` chord) silently no-op against a torn-
 * down React tree (handle methods short-circuit after close).
 *
 * Safe to fire synchronously even mid-replacement: every open path
 * (`openCityWorkspace`, `openFile`, `openGlobalKanban`, `openGlobalFind`)
 * calls `activeWorkspaceHandle?.close()` *before* setting the new state, so
 * the order is always close-clears-then-assign. The vellumMount.then() that
 * installs the new handle runs as a microtask after this fire-and-clear, so
 * we never wipe a freshly-installed reference.
 */
function handleWorkspaceClosed(): void {
  activeWorkspaceCityId = null
  activeWorkspaceHandle = null
  kanbanLaunchButton.refreshSoon()
}

/**
 * Open the global kanban — vellum mounted with `scope=global` (no cityId)
 * and the Kanban tab active at first paint. Single entry point for the
 * launch button + `k` hotkey since Stage 6 retired the standalone modal
 * (the standalone path itself was collapsed in Stage 8).
 *
 * If a vellum modal is already up, flip its mode to Kanban in place rather
 * than tearing down and remounting — the constitution's "Hotkey k semantics"
 * specifically asks for in-place flip on any open vellum.
 */
function openGlobalKanban(): void {
  if (activeWorkspaceHandle) {
    activeWorkspaceHandle.setMode('kanban')
    return
  }
  activeWorkspaceCityId = null
  const myToken = ++workspaceOpenToken
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    if (myToken !== workspaceOpenToken) return
    activeWorkspaceHandle = openVellumWorkspaceModal({
      initialMode: 'kanban',
      onOpenWorker: focusWorkerByTmuxSession,
      // The global kanban has no fiber graph (cityId is undefined) — every
      // card click needs to pivot vellum to the card's owning city.
      onOpenFiberInCity: openFiberInCityFromKanban,
      onClose: handleWorkspaceClosed,
    })
  })
}

/**
 * Open vellum on the Find tab in *global scope* (no cityId). Mirror of
 * `openGlobalKanban` for the navigation-layer constitution's `/` hotkey,
 * Stage A. If a vellum is already open, flip its tab to Find in place
 * rather than tearing down — same in-place pattern as the `k` chord.
 *
 * Scope is communicated to FindHost via the modal's `cityId` (undefined =
 * global). The `/` hotkey's scope ladder calls this for the global rung;
 * for the city rung it calls `openCityWorkspace(city, { initialMode: 'find' })`.
 */
function openGlobalFind(): void {
  if (activeWorkspaceHandle) {
    activeWorkspaceHandle.setMode('find')
    return
  }
  activeWorkspaceCityId = null
  const myToken = ++workspaceOpenToken
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    if (myToken !== workspaceOpenToken) return
    activeWorkspaceHandle = openVellumWorkspaceModal({
      initialMode: 'find',
      onOpenWorker: focusWorkerByTmuxSession,
      // Global Find has no fiber graph (cityId undefined); fiber clicks from
      // the (forthcoming Stage B) tree pivot vellum to the card's owning city.
      onOpenFiberInCity: openFiberInCityFromKanban,
      onClose: handleWorkspaceClosed,
    })
  })
}

/**
 * Resolve a kanban-card's owning cityId to a City and open vellum scoped to
 * it with the fiber selected and the prose visible. Used by both the global
 * and the city-scoped kanban click paths so cross-city click-through is
 * uniform: closing the current modal and opening a fresh one is the only
 * way to land vellum on a new collection (the adapter is constructed with
 * cityId at modal-open time).
 *
 * If the cityId doesn't resolve to a known local city (e.g. a remote-origin
 * card that the server somehow tagged with a stale id), we log and bail —
 * the modal stays where it is rather than closing onto nothing.
 */
function openFiberInCityFromKanban(cityId: string, slug: string): void {
  const city = cities.find(c => c.id === cityId)
  if (!city) {
    console.warn('[Kanban] click-through to unknown cityId:', cityId, 'slug:', slug)
    return
  }
  openCityWorkspace(city, { initialSlug: slug, initialMode: 'narrative' })
}

/**
 * Resolve a tmux session name to a portolan session and pivot the camera +
 * focus its kitty tab. Used by the vellum-embedded KanbanHost via the
 * `onOpenWorker` plumbing on `openVellumWorkspaceModal` so a click on a
 * running-worker indicator inside a card brings up the live terminal.
 */
function focusWorkerByTmuxSession(tmuxSessionName: string): void {
  const session = sessions.find(s => s.tmuxSession === tmuxSessionName)
  if (!session) {
    console.warn('[Kanban] no session tracked for tmux name:', tmuxSessionName)
    return
  }
  const swarmPos = zoneRenderer.getSwarmWorldPosition(session.id)
  if (swarmPos) camera.focusAndZoom(swarmPos, 6, 0.95)
  else if (session.hex) camera.focusAndZoom(hexGrid.axialToCartesian(session.hex), 6, 0.95)
  mapActions?.focusKittyTab(session.id)
}

// URL-param auto-open retained for deep-linking and debugging.
const initialParams = new URLSearchParams(window.location.search)
const debugPath = initialParams.get('vellumDebug')
if (debugPath) {
  const lineParam = initialParams.get('vellumLine')
  const jumpToLine = lineParam ? Number(lineParam) : undefined
  openFile({
    path: debugPath,
    originId: initialParams.get('vellumOrigin') ?? undefined,
    cityId: initialParams.get('vellumCity') ?? undefined,
    editable: initialParams.get('vellumEdit') !== '0',
    jumpToLine: Number.isFinite(jumpToLine) ? jumpToLine : undefined,
  })
}

// Wire up file click from worker hover tooltip to vellum.
zoneRenderer.setWorkerFileClickHandler((fullPath, originId, _workerId) => {
  const city = findBestMatchingCity(cities, originId, fullPath)
  openFile({ path: fullPath, originId, cityId: city?.id })
})

// HUD file/fiber click → vellum modal. Fiber paths land in the workspace
// modal at that fiber's slug; everything else lands in file mode. The
// previous floating-card spawn path retired with
// [[constitution-remove-floating-cards]].
cityPanel.setOnOpenFile((fullPath, originId, _cityPath, cityId, line) => {
  const city = cities.find(c => c.id === cityId)
  if (!city) return
  const fiberMatch = /\/\.felt\/([^/]+)\/\1\.md$/.exec(fullPath)
  if (fiberMatch) {
    cityPanel.hide()
    openCityWorkspace(city, { initialSlug: fiberMatch[1] })
    return
  }
  openFile({ path: fullPath, originId, cityId: city.id, jumpToLine: line })
})

// Setup context menu
const contextMenu = new ContextMenu()

// Setup new worker dialog
const newWorkerDialog = new NewWorkerDialog()

// Wire up new worker dialog to city panel
cityPanel.setNewWorkerDialog(newWorkerDialog)

// Wire up worker click from city HUD
cityPanel.setOnFocusWorker((sessionId) => {
  mapActions?.focusKittyTab(sessionId)
})

cityPanel.setOnViewClaims((city) => {
  cityPanel.hide()
  openCityWorkspace(city)
})

// Setup playground viewer
const playgroundViewer = new PlaygroundViewer()

const globalSearchPalette = new GlobalSearchPalette({
  onSelectCity: (city) => {
    handleCityClick(city)
  },
  onSelectWorker: (session) => {
    const swarmPos = zoneRenderer.getSwarmWorldPosition(session.id)
    if (swarmPos) {
      camera.focusAndZoom(swarmPos, 6, 0.95)
    } else if (session.hex) {
      camera.focusAndZoom(hexGrid.axialToCartesian(session.hex), 6, 0.95)
    }
    mapActions?.focusKittyTab(session.id)
  },
  // Stage 2 of constitution-portolan-navigation-layer — fiber matches in
  // the cross-project search. The hit carries cityId + projectSlug for
  // local-origin fibers (the click-through identifier vellum's collection
  // expects); remote-origin hits carry only id/originId today and route
  // through the bare-slug locate path until per-origin remote vellum
  // navigation lands in a follow-up constitution.
  onSelectFiber: (hit) => {
    void openFiberFromSearch(hit)
  },
  searchFibers: async (query) => {
    const host = window.location.hostname
    const url = `http://${host}:4004/global-search?q=${encodeURIComponent(query)}&limit=20`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`global-search ${res.status}`)
    const data = await res.json()
    return Array.isArray(data?.hits) ? data.hits : []
  },
})

/**
 * Open a fiber matched in the cross-project search palette.
 *
 *   - Local origin with cityId resolved → pivot vellum into that city's
 *     collection at the project-relative slug. Same surface a city-HUD
 *     fiber click already lands on.
 *   - Local origin without cityId (an unpinned felt host) → fall back to
 *     `resolveFiberCity` over `/fiber-locate`; if still not found, surface
 *     a console warning rather than silently dropping the click.
 *   - Remote origin → no per-origin vellum collection exists yet (the
 *     navigation layer's vellum-side cross-project rendering is deferred
 *     per the constitution's Scope §"Out"). Open vellum in file mode at
 *     the snapshot's md path, which the existing static-felt asset route
 *     can serve. Console-warn so the gap is discoverable until follow-up
 *     work lands.
 */
async function openFiberFromSearch(hit: import('./ui/GlobalSearchPalette').FiberSearchHit): Promise<void> {
  if (hit.originId === 'local') {
    if (hit.cityId) {
      const city = cities.find(c => c.id === hit.cityId)
      if (city) {
        openCityWorkspace(city, { initialSlug: hit.projectSlug ?? hit.id })
        return
      }
    }
    // Pinned-city path didn't resolve; let the server tell us which local
    // city owns the slug (mirrors the URL-fragment fiber-nav path).
    const slug = hit.projectSlug ?? hit.id
    const owner = await resolveFiberCity(slug, cities)
    if (owner) {
      openCityWorkspace(owner, { initialSlug: slug })
      return
    }
    console.warn('[search] could not resolve local fiber to a pinned city:', hit.id)
    return
  }
  // Remote-origin hit. Per-origin vellum navigation is a follow-up; for
  // now, log so the gap is observable. Drag-from-search → vellum-on-remote
  // would land naturally once the agent ships per-fiber file-content.
  console.warn(
    `[search] remote-origin fiber click is not yet wired ` +
    `(originId=${hit.originId}, id=${hit.id}). Follow-up work in the ` +
    `navigation-layer constitution.`,
  )
}

// Kanban: global view of constitution-tagged fibers, grouped by lifecycle.
// Every entry point (launch button, hotkey `k`, city HUD's "Open kanban
// scoped to <city>" button) opens vellum-on-the-relevant-scope with the
// Kanban tab active — see openGlobalKanban / openCityWorkspace +
// vellum-reader/constitution-vellum-kanban. The KanbanModal class is
// instantiated per-mount inside vellum's workspace slot by KanbanHost; the
// standalone full-viewport path (Stage 6 retired the entry points; Stage 8
// collapsed the code) is gone.

const kanbanLaunchButton = new KanbanLaunchButton({
  onOpen: openGlobalKanban,
  // Pause the awaiting-review badge poll while vellum is showing the kanban
  // tab — the embedded grid maintains its own counts there. Vellum on
  // narrative/delta still polls so the badge stays current.
  isModalOpen: () => activeWorkspaceHandle?.getMode?.() === 'kanban',
})

const recentWorkerBar = new RecentWorkerBar({
  onSelectWorker: (session) => {
    const swarmPos = zoneRenderer.getSwarmWorldPosition(session.id)
    if (swarmPos) {
      camera.focusAndZoom(swarmPos, 6, 0.95)
    } else if (session.hex) {
      camera.focusAndZoom(hexGrid.axialToCartesian(session.hex), 6, 0.95)
    }
    mapActions?.focusKittyTab(session.id)
  },
  onFileClick: (fullPath, originId, _workerId) => {
    const city = findBestMatchingCity(cities, originId, fullPath)
    openFile({ path: fullPath, originId, cityId: city?.id })
  },
})

// Wire up View Playgrounds button
cityPanel.setOnViewPlaygrounds((city) => {
  playgroundViewer.show(city)
})

// City HUD's "Open kanban scoped to <city>" button — opens vellum-on-this-
// city with the Kanban tab active at first paint. Hosted inside vellum's
// chrome so the user can flip to Narrative/Delta in place without re-
// opening anything. See ai-futures/portolan/vellum-reader/constitution-
// vellum-kanban §"Stage 6".
cityPanel.setOnViewKanban((city) => {
  cityPanel.hide()
  openCityWorkspace(city, { initialMode: 'kanban' })
})

// State
let cities: City[] = []
let sessions: Session[] = []
let origins: ServerOrigin[] = []
let selectedHex: { q: number; r: number } | null = null
let mapActions: FrontendMapActions | null = null

// Register portolan state getters with the vellum mount layer so the
// annotation-action handlers (send-to-worker, save-as-fiber) can resolve a
// worker session and city path for any open file. See annotation-actions.
void vellumMountPromise.then(({ setPortolanMountContext }) => {
  setPortolanMountContext({
    getSessions: () => sessions,
    getCities: () => cities,
  })
})

// Move mode: when set, next click will move this city to that hex
let movingCityId: string | null = null

const stateSync = new FrontendStateSync({
  handlePanelMessage: (message) => cityPanel.handleMessage(message),
  onSocketOpen: (socket) => {
    cityPanel.setWebSocket(socket)
  },
  onStateChange: ({ cities: nextCities, sessions: nextSessions, origins: nextOrigins, activityBySessionKey, meetingBridge, isInitialState, urlCityId, urlFiberSlug }) => {
    cities = nextCities
    sessions = nextSessions
    origins = nextOrigins

    zoneRenderer.updateState(cities, sessions)
    for (const session of sessions) {
      const activitySessionKey = getActivitySessionKey(session.originId, session.tmuxSession)
      const activities = activityBySessionKey.get(activitySessionKey)
      if (activities) {
        zoneRenderer.updateWorkerActivity(activitySessionKey, activities)
      }
    }

    cityPanel.updateWorkers(sessions)
    cityPanel.updateMeetingState(meetingBridge)
    recentWorkerBar.update(cities, sessions)

    if (!isInitialState || cities.length === 0) return

    let mostRecentCity: City | null = null
    let mostRecentTime = 0
    for (const session of sessions) {
      if (session.cityId && session.lastActivity > mostRecentTime) {
        const city = cities.find(c => c.id === session.cityId)
        if (city) {
          mostRecentCity = city
          mostRecentTime = session.lastActivity
        }
      }
    }

    // `?city=X` / `#city=X` wins over most-recent-activity heuristic. Without
    // this, deep links opened the workspace but never ran handleCityClick —
    // HUD stayed empty and pins never loaded until the user clicked the hex.
    // X may be a city id (opaque hash) or a city name (what the user sees in
    // URLs and the HUD); match by id first, then by name, and prefer names
    // with active sessions when multiple cities share a name. See
    // hash-restore-does-not-select-city.
    const urlCity = urlCityId ? resolveCityFromUrlId(urlCityId) : null
    const targetCity = urlCity || mostRecentCity || cities[0]
    console.log(
      '[InitialFocus]',
      urlCity ? `URL: ${targetCity.name}` : mostRecentCity ? `Most recent: ${targetCity.name}` : `Fallback: ${targetCity.name}`,
      sessions.length,
      'sessions,',
      sessions.filter(s => s.cityId).length,
      'with cityId'
    )
    handleCityClick(targetCity)

    if (urlFiberSlug) {
      // `#fiber=Y` opens the vellum workspace at that fiber. When `#city=X`
      // is present it scopes the lookup; otherwise we ask the server which
      // local city owns the slug. Either way, fall back to opening the
      // targetCity's workspace without the slug if resolution fails so the
      // user still lands somewhere coherent. See
      // vellum-dogfood/url-fragment-fiber-nav.
      cityPanel.hide()
      if (urlCity) {
        openCityWorkspace(urlCity, { initialSlug: urlFiberSlug })
      } else {
        void resolveFiberCity(urlFiberSlug, cities).then((hit) => {
          if (hit) {
            handleCityClick(hit)
            openCityWorkspace(hit, { initialSlug: urlFiberSlug })
          } else {
            // Comment above said "fall back to the targetCity's workspace
            // without the slug." The code passed the slug anyway, so vellum
            // tried to load it and rendered its internal not-found message
            // ("Fiber X not found. Is mystra running on port 3100?") on a
            // city the user never asked for. Land on the targetCity's entry
            // point instead — coherent fallback, and the warn carries the
            // diagnostic for anyone watching console.
            console.warn('[InitialFocus] #fiber=', urlFiberSlug, 'not found in any local city')
            openCityWorkspace(targetCity)
          }
        })
      }
    } else if (urlCity) {
      cityPanel.hide()
      openCityWorkspace(urlCity)
    }
  },
  onActivity: ({ activitySessionKey, activities }) => {
    zoneRenderer.updateWorkerActivity(activitySessionKey, activities)
    appRuntime.scheduleWorkerHudUpdate()
  },
  onServerError: (message) => {
    console.error('[Frontend] Server error:', message)
    alert(message)
  },
})

// Mid-session hash navigation — `#city=X` / `#fiber=Y` re-runs the deep-link
// resolution. Without this, pasting a hash URL into the address bar or hitting
// browser back/forward changed `location.hash` but left the HUD, camera, and
// workspace pinned to whatever was previously selected; only a full reload
// (different path or query) actually routed the URL. Same flow as InitialFocus:
// pick the city, click it (HUD + camera focus), and if a fiber slug is present
// open the vellum workspace at it. See `hash-restore-does-not-select-city`.
window.addEventListener('hashchange', () => {
  const urlCityId = readUrlCityId()
  const urlFiberSlug = readUrlFiberSlug()
  if (!urlCityId && !urlFiberSlug) return
  // Bail before initial state arrives. Vite HMR (and some agent-browser
  // navigations) fire hashchange before the WS delivers cities; resolving
  // against an empty city list would warn-and-no-op for a hash that
  // InitialFocus is about to handle correctly. Once cities load, normal
  // hash navigation runs through this handler.
  if (cities.length === 0) return
  const urlCity = urlCityId ? resolveCityFromUrlId(urlCityId) : null
  if (urlCityId && !urlCity) {
    // Stale link or now-removed city: warn for symmetry with the #fiber=
    // branch below so console traffic is even, and fall through to the
    // urlFiberSlug branch which can still resolve city-by-fiber.
    console.warn('[hashchange] #city=', urlCityId, 'not found in any local or remote city')
  }
  if (urlCity) handleCityClick(urlCity)
  if (urlFiberSlug) {
    cityPanel.hide()
    if (urlCity) {
      openCityWorkspace(urlCity, { initialSlug: urlFiberSlug })
    } else {
      void resolveFiberCity(urlFiberSlug, cities).then((hit) => {
        if (hit) {
          handleCityClick(hit)
          openCityWorkspace(hit, { initialSlug: urlFiberSlug })
        } else {
          console.warn('[hashchange] #fiber=', urlFiberSlug, 'not found in any local city')
        }
      })
    }
  } else if (urlCity) {
    cityPanel.hide()
    openCityWorkspace(urlCity)
  }
})

const mapInteractions = new MapInteractionController({
  canvas: canvasOverlay,
  camera,
  hexGrid,
  zoneRenderer,
  contextMenu,
  getCities: () => cities,
  getSessions: () => sessions,
  getMovingCityId: () => movingCityId,
  setMovingCityId: (cityId) => { movingCityId = cityId },
  setSelectedHex: (hex) => { selectedHex = hex },
  handleCityClick,
  handleDeepCityPress: (city) => {
    handleCityClick(city)
    if (city.hasClaims) {
      cityPanel.hide()
      openCityWorkspace(city)
    } else {
      playgroundViewer.show(city)
    }
  },
  promptNewWorker: (city) => mapActions!.promptNewWorker(city),
  promptAddCity: (hex) => mapActions!.promptAddCity(hex),
  unpinCity: (cityId) => mapActions!.unpinCity(cityId),
  focusKittyTab: (sessionId) => mapActions!.focusKittyTab(sessionId),
  killWorker: (sessionId) => mapActions!.killWorker(sessionId),
  moveCity: (cityId, hex) => {
    mapActions!.moveCity(cityId, hex)
  },
  findNearestCity: (hex) => findNearestCity(cities, hexGrid, hex),
})

mapActions = new FrontendMapActions({
  newWorkerDialog,
  sendMessage: (message) => stateSync.send(message),
  getWebSocketState: () => stateSync.getWebSocketState(),
  showCity: (city) => cityPanel.show(city),
})

const isEditableElement = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  const tagName = element.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

// `/` — scope-step ladder for the Find tab (constitution-portolan-navigation-
// layer §"/ chord — scope-step semantics"). Bound at *capture phase* on
// document so it beats vellum's own FiberPage `/` handler (which focuses the
// in-collection thumb-index search input). Once we own the keystroke we
// stopImmediatePropagation so vellum's bubble-phase listener never sees it
// — otherwise the second `/` press would focus vellum's search input first,
// flipping document.activeElement to an editable target before we read it,
// and our scope-ladder would short-circuit on the isEditableElement guard.
//
// Each press climbs one rung:
//
//   - vellum closed, no focused city → open vellum-on-Find in global scope.
//   - vellum closed, focused city X  → open vellum-on-Find scoped to X.
//   - vellum open, not on Find       → flip the active tab to Find in place
//                                       (mirrors the `k` chord for kanban).
//   - vellum open on Find at city X  → escalate to global scope (close +
//                                       reopen with no cityId, mode=find).
//   - vellum open on Find at global  → close vellum (returns to the map).
//
// The user can always reach global by pressing `/` twice. Pure ladder; no
// chord-detection or timing semantics. The standalone GlobalSearchPalette
// is no longer bound to `/` — it stays in the codebase through Stage B and
// retires in Stage C once Find's search input lands.
const onFindHotkey = (event: KeyboardEvent): void => {
  if (event.key !== '/') return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (isEditableElement(document.activeElement)) return

  event.preventDefault()
  // Beat vellum's bubble-phase `/` handler (FiberPage thumb-index search).
  // Without stopImmediatePropagation, vellum focuses its in-collection
  // search input *after* we open Find, leaving the user typing into the
  // wrong control.
  event.stopImmediatePropagation()

  const handle = activeWorkspaceHandle
  if (!handle) {
    // Vellum closed. Pick scope from focused-city, falling back to global.
    // Same focus resolution `t` uses so the two hotkeys agree on what
    // "current city" means — the visible HUD wins, otherwise the most-
    // recently-focused city sticks (vellum-dogfood/t-key-needs-hud).
    const visibleCity = cityPanel.getCurrentCity()
    const focusedCity = visibleCity
      ?? (lastFocusedCityId ? cities.find(c => c.id === lastFocusedCityId) ?? null : null)
    if (focusedCity) {
      cityPanel.hide()
      openCityWorkspace(focusedCity, { initialMode: 'find' })
    } else {
      openGlobalFind()
    }
    return
  }

  if (handle.getMode() !== 'find') {
    handle.setMode('find')
    return
  }

  // Already on Find. Climb the scope ladder: city → global → close.
  if (activeWorkspaceCityId !== null) {
    handle.close()
    activeWorkspaceHandle = null
    activeWorkspaceCityId = null
    openGlobalFind()
    return
  }
  // Already global Find — close.
  handle.close()
  activeWorkspaceHandle = null
  activeWorkspaceCityId = null
}

// Capture phase + document so we land before vellum's document-bubble handler.
document.addEventListener('keydown', onFindHotkey, true)

const onGlobalHotkeys = (event: KeyboardEvent): void => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (isEditableElement(document.activeElement)) return
  if (globalSearchPalette.isVisible()) return

  // `n` requires a visible HUD: creating a new worker is HUD-scoped action and
  // there's no obvious target city when nothing is on screen. `t`, by contrast,
  // is "open the workspace for whatever city is in focus" — fall back to the
  // most-recently-shown city so the same key that just closed the workspace
  // can reopen it without first re-summoning the HUD. See
  // vellum-dogfood/t-key-needs-hud.
  const visibleCity = cityPanel.getCurrentCity()
  const focusedCity = visibleCity
    ?? (lastFocusedCityId ? cities.find(c => c.id === lastFocusedCityId) ?? null : null)

  if (event.key === 'n' && visibleCity && cityPanel.isVisible()) {
    event.preventDefault()
    void mapActions?.promptNewWorker(visibleCity)
    return
  }

  if (event.key === 't' && focusedCity) {
    event.preventDefault()
    cityPanel.hide()
    openCityWorkspace(focusedCity)
    return
  }

  // Kanban — global view of constitution-tagged fibers. Independent of any
  // city/HUD focus; works at any time the global hotkey gate above passes.
  //
  // Stage 6 semantics (constitution §"Hotkey k semantics"):
  //   - vellum closed   → open vellum-on-global with Kanban tab active.
  //   - vellum open, !kanban → flip to Kanban tab in place.
  //   - vellum open, on kanban → close vellum (mirrors the legacy
  //     standalone-modal toggle so a second `k` still dismisses).
  if (event.key === 'k') {
    event.preventDefault()
    const handle = activeWorkspaceHandle
    if (!handle) {
      openGlobalKanban()
      return
    }
    if (handle.getMode() === 'kanban') {
      handle.close()
      activeWorkspaceHandle = null
      kanbanLaunchButton.refreshSoon()
    } else {
      handle.setMode('kanban')
    }
  }
}

window.addEventListener('keydown', onGlobalHotkeys)

let lastCameraRevision = camera.cameraRevision

const appRuntime = new FrontendAppRuntime({
  renderer,
  scene,
  labelRenderer,
  camera,
  zoneRenderer,
  stateSync,
  mapInteractions,
  cityPanel,
  contextMenu,
  newWorkerDialog,
  playgroundViewer,
  clearArtifactMediaCaches,
  getCities: () => cities,
  updateWorkerHud: () => cityPanel.updateWorkers(sessions),
  isWorkerHudVisible: () => cityPanel.isVisible(),
  applyMockState: (mockCities, mockSessions) => {
    cities = mockCities
    sessions = mockSessions
    zoneRenderer.updateState(cities, sessions)
  },
  onFrame: () => {
    if (camera.cameraRevision === lastCameraRevision) return
    lastCameraRevision = camera.cameraRevision
    // Camera pan/zoom doesn't emit mousemove, so re-test hover from the
    // last-known cursor position — otherwise zooming leaves stale state.
    mapInteractions.recomputeHover()
  },
})

installFrontendRuntimeDiagnostics({
  renderer,
  zoneRenderer,
  cityPanel,
  playgroundViewer,
  getArtifactMediaCacheStats,
  getRuntimeDisposed: () => appRuntime.isDisposed(),
  getWebSocketState: () => stateSync.getWebSocketState(),
  hasReconnectTimeout: () => stateSync.hasPendingReconnect(),
  hasReceivedInitialState: () => stateSync.getHasReceivedInitialState(),
  getWorldStats: () => ({
    cityCount: cities.length,
    sessionCount: sessions.length,
    originCount: origins.length,
    selectedHex: selectedHex ? { q: selectedHex.q, r: selectedHex.r } : null,
  }),
  getActivityStats: () => stateSync.getActivityStats(),
  getHudStats: () => appRuntime.getHudStats(),
})

stateSync.connect()
appRuntime.start()

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    document.removeEventListener('keydown', onFindHotkey, true)
    window.removeEventListener('keydown', onGlobalHotkeys)
    globalSearchPalette.hide()
    recentWorkerBar.dispose()
    appRuntime.dispose()
  })
}
