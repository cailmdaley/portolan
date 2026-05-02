// main.ts - Bootstrap and render loop

import {
  Scene,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Color,
} from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { tinykeys } from 'tinykeys'
import { HexGrid } from './render/HexGrid'
import { ZoneRenderer } from './render/ZoneRenderer'
import { Camera } from './render/Camera'

// Vellum is the file/fiber reading surface; map clicks open it as a modal.
// Lazy-imported so the vendored bundle isn't pulled into the initial paint.
// See [[constitution-remove-floating-cards]] — fiber-level content lives in
// vellum, not as a floating card on the map.
const vellumMountPromise = import('./vellum/mount')
import type { VellumModalHandle } from './vellum/mount'
// `find-shared` is a tiny constants module — safe to import eagerly without
// pulling the React tree into the initial paint.
import { FIND_FOCUS_SEARCH_EVENT, FIND_SEARCH_INPUT_CLASS } from './vellum/find-shared'
import { MapInteractionController } from './MapInteractionController'
import { FrontendMapActions } from './FrontendMapActions'
import { installFrontendRuntimeDiagnostics } from './runtime/FrontendRuntimeDiagnostics'
import { getActivitySessionKey } from './runtime/FrontendActivityStore'
import { FrontendStateSync } from './runtime/FrontendStateSync'
import { DirectoryListingClient } from './runtime/DirectoryListingClient'
import { FrontendAppRuntime } from './runtime/FrontendAppRuntime'
import { UrlFragmentSync, SCOPE_GLOBAL, type UrlState, type VellumMode } from './runtime/UrlFragment'
import { ContextMenu } from './ui/ContextMenu'
import { PlaygroundViewer } from './ui/PlaygroundViewer'
import { NewWorkerDialog } from './ui/NewWorkerDialog'
// Stage H of constitution-portolan-navigation-layer: MapChromeBar is the
// only persistent UI on top of the map (vellum launch + V/K/F chips +
// worker birds + glance + awaiting-review badge); it replaced the
// predecessor `KanbanLaunchButton` + `RecentWorkerBar` widgets in Stage H,
// and the CityHUD overlay + `GlobalSearchPalette` retired alongside it in
// Stage I. The map now shows just geography + this bar; per-city detail
// lives entirely in vellum's Find tab.
import { MapChromeBar } from './ui/MapChromeBar'
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
// link). Drives the v/k hotkeys' "act on the focused city" semantics and
// the chrome bar's launch-button fallback. Stage I of the navigation-layer
// constitution made this the *only* notion of focus — the CityHUD overlay
// retired, so a hex click sets `lastFocusedCityId` and moves the camera
// and that's it; no panel is summoned. Stage J round-trips this through
// the URL fragment via `pushCurrentUrl()` below.
let lastFocusedCityId: string | null = null
let refreshKanbanBadgeSoon: () => void = () => { /* noop until chrome bar is constructed */ }

/* ─────────────────────────────────────────────────────────────────────────
 * Stage J — URL-fragment-stable navigation
 *
 * The four axes that round-trip through `#…` (per
 * [[ai-futures/portolan/design/constitution-portolan-navigation-layer]]
 * §"URL-stable navigation"):
 *
 *   - `cityId`     ← `lastFocusedCityId` (above)
 *   - `mode`       ← which vellum tab is open, or absent if vellum is closed
 *   - `fiberSlug`  ← active fiber (narrative mode) or `null` for city index
 *   - `filePath`   ← active file (narrative mode in file mode)
 *   - `scopeCityId`← Find/Kanban scope when it diverges from `cityId`
 *                    (`SCOPE_GLOBAL` for explicit global with a focused city)
 *
 * Every open / close / scope-change updates these vars and calls
 * `pushCurrentUrl()`, which builds the canonical state and either
 * `pushState`s or no-ops (when the URL already matches). `popstate` /
 * `hashchange` flow through `applyUrlState()` to converge the UI.
 *
 * Suppression of incidental URL writes during convergence is owned by
 * `UrlFragmentSync.runSuppressed`; everything in this module just calls
 * `pushCurrentUrl()` and lets the sync layer decide.
 * ────────────────────────────────────────────────────────────────────── */
const urlSync = new UrlFragmentSync()
let activeWorkspaceFiberSlug: string | null = null
let activeWorkspaceFilePath: string | null = null
/** Vellum scope tracker — distinct from `activeWorkspaceCityId` because
 *  Find tab lets the user re-scope in place without changing the modal's
 *  outer cityId. `null` = scope inherits from `lastFocusedCityId`;
 *  `SCOPE_GLOBAL` = explicit global override; cityId string = explicit
 *  city scope. Drives the `scope` URL param. */
let activeWorkspaceScopeOverride: string | typeof SCOPE_GLOBAL | null = null

/** Stage J — when the open paths (`openCityWorkspace` etc.) close the
 *  current modal as a prelude to opening a fresh one, `handleWorkspaceClosed`
 *  fires synchronously and would push a (transient) "vellum closed" URL
 *  entry between the old and new state. We set this flag around the
 *  close so the transient push is skipped; the subsequent open's
 *  commitVellumMode/pushCurrentUrl writes the final state directly.
 *
 *  Genuine closes (Escape key, × button, `v`/`k` toggle-close) don't
 *  flip the flag, so handleWorkspaceClosed pushes the closed-state URL
 *  as expected. */
let modalReopenInProgress = false

/** Stage J — whether vellum is *intended* to be open. Flipped true at the
 *  start of every open path (synchronously, before the async vellum-mount
 *  promise resolves) and false in `handleWorkspaceClosed`. This decouples
 *  URL-encoding-of-mode from the live `activeWorkspaceHandle` reference
 *  (which is null during the async window between open-call and mount),
 *  so commitVellumMode's URL push during that window still emits `mode`.
 *
 *  `lastVellumMode` continues to track the most-recent-tab semantic for
 *  the chrome bar's launch button — it's NOT cleared on close, so back-
 *  via-launch-button restores the last tab. `vellumOpenIntent` is the
 *  is-currently-open signal; the two are distinct on purpose. */
let vellumOpenIntent = false

/** Build the canonical URL state from the live module-level vars. Called
 *  by `pushCurrentUrl` and also by `applyUrlState` for diffing. The "is
 *  vellum open" check uses `vellumOpenIntent` rather than the live
 *  `activeWorkspaceHandle` so URL writes during the async mount window
 *  (between open-call and mount-completion) still emit `mode`. */
function buildCurrentUrlState(): UrlState {
  const state: UrlState = {}
  if (lastFocusedCityId) state.cityId = lastFocusedCityId

  if (vellumOpenIntent && lastVellumMode) {
    state.mode = lastVellumMode
    // Only narrative mode carries fiber/file in URL; in kanban/find the
    // fiber/file vars stay set across mode flips (so `v` after `k` can
    // land back on the same fiber) but they're not the user-visible nav
    // state for those tabs.
    if (lastVellumMode === 'narrative') {
      if (activeWorkspaceFiberSlug) state.fiberSlug = activeWorkspaceFiberSlug
      if (activeWorkspaceFilePath) state.filePath = activeWorkspaceFilePath
    }
    if (activeWorkspaceScopeOverride) state.scopeCityId = activeWorkspaceScopeOverride
  }
  return state
}

/** Push the URL fragment to match the current module-state. No-op when
 *  the URL already matches (e.g., redundant `commitVellumMode('find')` on
 *  in-place tab flips). Suppressed during popstate / hashchange
 *  convergence so the converging open paths don't double-push. */
function pushCurrentUrl(): void {
  urlSync.push(buildCurrentUrlState())
}

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

// Wire up city label click handler (needed for remote cities without sprites).
// Uses handleCityClick defined below.
zoneRenderer.setCityLabelClickHandler((cityId) => {
  const city = cities.find(c => c.id === cityId)
  if (city) handleCityClick(city)
})

// Provide camera's screen-to-world conversion for accurate drag
zoneRenderer.setScreenToWorldConverter((x, y) => camera.screenToWorld(x, y))

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

// Shared handler for city clicks (used by sprite click and label click).
// Stage I — hex click only sets focus + moves the camera. The CityHUD
// overlay retired; per-city detail lives in vellum's Find tab now (open
// with `/` or the chrome bar's F chip), and `v` / `k` open
// narrative / kanban scoped to the focused city.
function handleCityClick(city: City): void {
  selectedHex = city.hex
  const cityChanged = lastFocusedCityId !== city.id
  lastFocusedCityId = city.id

  // Focus on city and zoom to detail level
  const pos = hexGrid.axialToCartesian(city.hex)
  camera.focusAndZoom(pos, 6, 0.95)

  if (city.isDormant && city.originId !== 'local') {
    void mapActions?.activateRemoteCity(city)
  }

  // Stage J — push the new focused city into the URL fragment so back/
  // forward navigates the camera. Skip the no-op case so a `v` after a
  // hex-click on the same city doesn't sediment two identical history
  // entries; pushCurrentUrl already short-circuits state-equal writes,
  // but the explicit guard documents the intent.
  if (cityChanged) {
    pushCurrentUrl()
    refreshKanbanBadgeSoon()
  }
}

// `commitVellumMode` is reassigned to the real implementation below once
// `mapChromeBar` is constructed. The declaration up here lets the open paths
// (openFile / openCityWorkspace / openGlobalKanban / openGlobalFind) reference
// it without caring about module-init order — the debugPath auto-open runs
// before the chrome bar exists, so we ship a noop until the real one lands.
//
// Stage H — single helper every open / mode-flip / close path threads
// through. Pushes the mode into the chrome bar (so the V/K/F chip
// highlights track the active vellum tab) and remembers it for the
// launch button's "open the last view" affordance. Pass `null` when
// vellum closes. Stage J will widen this so reload restores the same
// view without needing a session-local memo.
let lastVellumMode: 'narrative' | 'kanban' | 'find' | null = null
// Reassigned at chrome-bar construction; see `commitVellumMode = …` below.
let commitVellumMode: (mode: 'narrative' | 'kanban' | 'find' | null) => void
  = (_mode) => { /* noop until chrome bar is constructed */ }

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
  modalReopenInProgress = true
  activeWorkspaceHandle?.close()
  activeWorkspaceHandle = null
  modalReopenInProgress = false
  vellumOpenIntent = true
  activeWorkspaceCityId = args.cityId ?? null
  // Stage J — track the file path and clear fiber/scope so the URL
  // fragment reflects file mode (`mode=narrative&file=…`).
  activeWorkspaceFilePath = args.path
  activeWorkspaceFiberSlug = null
  activeWorkspaceScopeOverride = null
  // Stage H — file mode lives in the narrative slot (vellum disables
  // workspace + delta tabs in file mode). Light the V chip so the chrome
  // bar reflects the current reading surface.
  commitVellumMode('narrative')
  pushCurrentUrl()
  const myToken = ++workspaceOpenToken
  // Stage G recents — every file open is a human view. Skips silently if
  // there's no resolved city (file system path with no owning city);
  // those don't have a meaningful Recents row.
  if (args.cityId && args.path) {
    recordRecentTouch({ kind: 'file', cityId: args.cityId, originId: args.originId, path: args.path })
  }
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
  /** Stage J — initial Find/Kanban scope override. Used by the URL applier
   *  when restoring a `&scope=…` deep link with mode=find/kanban: e.g., the
   *  user was on Find at city X, scoped to global → URL `mode=find&city=X
   *  &scope=global` → reload calls `openCityWorkspace(X, { initialMode:
   *  'find', initialScope: SCOPE_GLOBAL })`, and the FindHost mounts with
   *  scope=global rather than inheriting cityId. Plumbed down to FindHost
   *  via the `findInitialScope` option on `openVellumWorkspaceModal`. */
  initialScope?: string | typeof SCOPE_GLOBAL
}

function openCityWorkspace(city: City, opts: OpenCityWorkspaceOpts = {}): void {
  modalReopenInProgress = true
  activeWorkspaceHandle?.close()
  activeWorkspaceHandle = null
  modalReopenInProgress = false
  vellumOpenIntent = true
  activeWorkspaceCityId = city.id
  // Stage J — track the fiber/file/scope so pushCurrentUrl encodes them.
  // Find scope inherits from the modal's cityId by default; the scope
  // override only kicks in when the user later flips Find scope or arrives
  // through a `&scope=…` deep link (the URL applier sets it explicitly via
  // `applyUrlState` before openCityWorkspace runs).
  activeWorkspaceFiberSlug = opts.initialSlug ?? null
  activeWorkspaceFilePath = null
  if (opts.initialScope === SCOPE_GLOBAL || (opts.initialScope && opts.initialScope !== city.id)) {
    activeWorkspaceScopeOverride = opts.initialScope
  } else {
    activeWorkspaceScopeOverride = null
  }
  // Stage H — push the requested tab into the chrome bar so the matching
  // V/K/F chip lights up immediately (before vellum's React tree mounts).
  // 'delta' isn't a chip mode; treat it as narrative for highlight
  // purposes (delta sits adjacent to narrative in vellum's tab order).
  const chipMode = opts.initialMode === 'kanban' ? 'kanban'
    : opts.initialMode === 'find' ? 'find'
    : 'narrative'
  commitVellumMode(chipMode)
  // Stage J — pivot the map camera to the modal city when this opener is
  // pivoting across cities (Find search-result click, kanban card click,
  // URL deep-link restore, etc.). Constitutional carve-out preserved
  // separately: Cities-column click in Find re-scopes Find *without*
  // moving the camera — that path goes through `handleFindScopeChange`,
  // not `openCityWorkspace`, so it doesn't reach this branch.
  //
  // Letting the camera follow modal city makes "URL `city=` matches the
  // modal city" an invariant (when vellum is open with a city), which
  // simplifies the convergence path: applyUrlState no longer has to keep
  // camera-city and modal-city as independent axes. The trade-off is the
  // map gently slides into position on cross-city fiber clicks; that's
  // consonant with the constitution's "v / map hex = go there" framing
  // (the user clicked through *to* a fiber — they meant to go there).
  if (lastFocusedCityId !== city.id) {
    handleCityClick(city)
  }
  pushCurrentUrl()
  const myToken = ++workspaceOpenToken
  // Stage G recents — fiber views from the URL-hash restore, FindHost
  // click-throughs, and kanban click-throughs all flow through here with
  // an `initialSlug`. Map-hex clicks land on Index without a slug and
  // are not recorded (no specific resource was viewed).
  if (opts.initialSlug && opts.initialMode !== 'kanban' && opts.initialMode !== 'find') {
    recordRecentTouch({ kind: 'fiber', cityId: city.id, originId: city.originId, path: opts.initialSlug })
  }
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
      // Stage J — propagate the FindHost scope override (only set when the
      // URL applier restored a `&scope=…` deep link, or when a Find scope
      // change is being applied via openCityWorkspace).
      findInitialScope: opts.initialScope,
      // Stage J — Find's Cities-column / ⊕ Global click flips
      // `localScopeCityId` inside FindHost; we mirror that into the URL
      // fragment so reload restores the user's chosen scope.
      onFindScopeChange: handleFindScopeChange,
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
 * Stage J — FindHost's scope-change callback. Fires when the user clicks
 * a city in the Cities column (re-scoping in place) or hits ⊕ Global to
 * clear scope. We mirror the new scope into the URL fragment so reload
 * restores it; reload-time the URL applier reads `&scope=…` and passes it
 * into `openCityWorkspace({ initialScope })`, which threads it to FindHost
 * via `findInitialScope`.
 *
 * `newScope === undefined` means "scope inherits from modal cityId" (the
 * pre-Stage-J default state). We encode this by clearing the URL `scope`
 * param. `null` (sent by FindHost when ⊕ Global is hit on a modal that
 * had a city scope) is encoded as `&scope=global` to make the explicit
 * choice durable.
 */
function handleFindScopeChange(newScope: string | null | undefined): void {
  if (newScope === null || (activeWorkspaceCityId && newScope === undefined)) {
    // FindHost flipped to global (⊕ Global). Encode explicit global.
    activeWorkspaceScopeOverride = SCOPE_GLOBAL
  } else if (newScope === undefined) {
    activeWorkspaceScopeOverride = null
  } else if (activeWorkspaceCityId && newScope === activeWorkspaceCityId) {
    // Re-scoping back to the modal's own city — that's the inherit-default.
    activeWorkspaceScopeOverride = null
  } else {
    activeWorkspaceScopeOverride = newScope
  }
  pushCurrentUrl()
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
  vellumOpenIntent = false
  // Stage J — clear the modal-state vars that feed the URL fragment. The
  // city focus stays (camera doesn't move on close); just the modal axes
  // (mode, fiber, file, scope) drop. lastVellumMode is preserved so the
  // chrome bar's launch button can re-open the same tab.
  activeWorkspaceFiberSlug = null
  activeWorkspaceFilePath = null
  activeWorkspaceScopeOverride = null
  // Vellum is gone — clear the chrome bar's chip highlight and refresh the
  // awaiting-review badge in case the user just closed the kanban tab
  // (Stage H — the chrome bar carries this responsibility now).
  mapChromeBar.syncMode(null)
  mapChromeBar.refreshSoon()
  // Stage J — push the closed-state URL only when this is a *genuine*
  // close (Escape, ×, hotkey toggle-close). Open-replacement (the
  // `openCityWorkspace` etc. close-then-reopen pattern) sets
  // `modalReopenInProgress` so the in-flight transition state isn't
  // sedimented into history.
  if (!modalReopenInProgress) pushCurrentUrl()
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
  // Stage J — global kanban scope is explicit-global, but only meaningful
  // alongside `mode=kanban`; clear the per-modal axes that don't apply.
  vellumOpenIntent = true
  activeWorkspaceFiberSlug = null
  activeWorkspaceFilePath = null
  activeWorkspaceScopeOverride = SCOPE_GLOBAL
  // Stage H — chip lights up regardless of the open-vs-flip branch.
  commitVellumMode('kanban')
  if (activeWorkspaceHandle) {
    activeWorkspaceHandle.setMode('kanban')
    pushCurrentUrl()
    return
  }
  activeWorkspaceCityId = null
  pushCurrentUrl()
  const myToken = ++workspaceOpenToken
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    if (myToken !== workspaceOpenToken) return
    activeWorkspaceHandle = openVellumWorkspaceModal({
      initialMode: 'kanban',
      onOpenWorker: focusWorkerByTmuxSession,
      // Stage J — Find scope-change callback; the kanban tab itself doesn't
      // surface scope, but if the user flips to Find from here the change
      // path goes through this same modal handle.
      onFindScopeChange: handleFindScopeChange,
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
  // Stage J — global Find scope is explicit-global; clear non-Find axes.
  vellumOpenIntent = true
  activeWorkspaceFiberSlug = null
  activeWorkspaceFilePath = null
  activeWorkspaceScopeOverride = SCOPE_GLOBAL
  // Stage H — chip lights up regardless of the open-vs-flip branch.
  commitVellumMode('find')
  if (activeWorkspaceHandle) {
    activeWorkspaceHandle.setMode('find')
    pushCurrentUrl()
    return
  }
  activeWorkspaceCityId = null
  pushCurrentUrl()
  const myToken = ++workspaceOpenToken
  void vellumMountPromise.then(({ openVellumWorkspaceModal }) => {
    if (myToken !== workspaceOpenToken) return
    activeWorkspaceHandle = openVellumWorkspaceModal({
      initialMode: 'find',
      // Stage J — initial scope = global, mirrored into FindHost.
      findInitialScope: SCOPE_GLOBAL,
      onFindScopeChange: handleFindScopeChange,
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

// Setup context menu
const contextMenu = new ContextMenu()

// Setup new worker dialog
const newWorkerDialog = new NewWorkerDialog()

// Setup playground viewer. Stage I — `playgroundViewer.show(city)` is
// reached via the deep-press affordance in `MapInteractionController`
// (force-click / two-finger-press on a city hex with `hasPlaygrounds` and
// no claims). Previously also wired through the CityHUD's "View
// Playgrounds" button, retired in this stage; the deep-press is the
// surviving primary affordance until a Playgrounds row lands in Find.
const playgroundViewer = new PlaygroundViewer()

// Kanban: global view of constitution-tagged fibers, grouped by lifecycle.
// Every entry point (launch button, hotkey `k`, city HUD's "Open kanban
// scoped to <city>" button) opens vellum-on-the-relevant-scope with the
// Kanban tab active — see openGlobalKanban / openCityWorkspace +
// vellum-reader/constitution-vellum-kanban. The KanbanModal class is
// instantiated per-mount inside vellum's workspace slot by KanbanHost; the
// standalone full-viewport path (Stage 6 retired the entry points; Stage 8
// collapsed the code) is gone.

// Stage H — single Civ-style chrome bar on top of the map. Carries the
// vellum launch button, V/K/F mode chips, worker birds (RecentWorkerBar's
// data, horizontal), and an awaiting-review/working glance. Mode-chip
// highlighting is pushed in by the host every time vellum opens, closes,
// or flips tabs (search for `mapChromeBar.syncMode` below).
const mapChromeBar = new MapChromeBar({
  onOpenLastView: () => openLastView(),
  onOpenNarrative: () => handleNarrativeHotkey(new KeyboardEvent('synthetic')),
  onOpenKanban: () => handleKanbanHotkey(new KeyboardEvent('synthetic')),
  onOpenFind: () => handleSlashHotkey(new KeyboardEvent('synthetic')),
  onSelectWorker: (session) => {
    const swarmPos = zoneRenderer.getSwarmWorldPosition(session.id)
    if (swarmPos) {
      camera.focusAndZoom(swarmPos, 6, 0.95)
    } else if (session.hex) {
      camera.focusAndZoom(hexGrid.axialToCartesian(session.hex), 6, 0.95)
    }
    mapActions?.focusKittyTab(session.id)
  },
  // Pause the awaiting-review badge poll while vellum is showing the kanban
  // tab — the embedded grid renders fresh counts there. Mirrors the
  // pre-Stage-H KanbanLaunchButton policy.
  isKanbanModalOpen: () => activeWorkspaceHandle?.getMode?.() === 'kanban',
  // Keep the K-chip badge scoped to the same kanban that pressing K would
  // reveal. Without this, the badge reports global awaiting-review count
  // while a focused city opens a city-scoped kanban, so the badge and the
  // visible cards disagree.
  getKanbanBadgeCityId: () => {
    if (activeWorkspaceHandle) return activeWorkspaceCityId
    return resolveFocusedCity()?.id ?? null
  },
})
refreshKanbanBadgeSoon = () => mapChromeBar.refreshSoon()

/**
 * Stage H — launch button. Open the vellum view that best matches "last
 * thing the user was reading."
 *
 * Pre-Stage-J the URL fragment doesn't carry tab/scope; we approximate by
 * reading `lastVellumMode` (set on every open / setMode below) and
 * combining with the focused city. Stage J will rewrite this against
 * `FrontendStateSync` once the URL fragment encodes mode + scope, at
 * which point the fallback ladder shrinks to "URL-fragment → focused-
 * city narrative → global kanban."
 */
function openLastView(): void {
  const handle = activeWorkspaceHandle
  if (handle) {
    // Vellum already up — promote the chrome bar's launch button to a
    // "go-to-last-tab" affordance: re-flip to the last interacted mode
    // (i.e. close-and-reopen surfaces the launch as a read-the-prose
    // sense rather than a tab-cycle). Keep simple: do nothing if vellum
    // is already open; the V/K/F chips handle in-vellum flips.
    return
  }
  const focusedCity = resolveFocusedCity()
  // Bug 1 fix: cover all `(focusedCity, lastVellumMode)` pairs.
  //
  //   focusedCity  |  lastVellumMode  |  action
  //   ─────────────┼──────────────────┼──────────────────────────
  //   set          │  *any*           │ openCityWorkspace(city, initialMode)
  //   null         │  kanban          │ openGlobalKanban()
  //   null         │  find            │ openGlobalFind()
  //   null         │  narrative|null  │ openGlobalKanban() [fallback]
  //
  // The key missing case before the fix: focusedCity=null, lastVellumMode='narrative'
  // fell through all branches silently. We now treat it as the same fallback as
  // the default: open the global kanban (the aggregate non-empty surface).
  if (focusedCity) {
    const mode = lastVellumMode === 'find' ? 'find'
      : lastVellumMode === 'kanban' ? 'kanban'
      : 'narrative'
    openCityWorkspace(focusedCity, { initialMode: mode })
    return
  }
  // No focused city; open the aggregate surface matching last mode,
  // defaulting to global kanban (the non-empty fallback per Bug 1
  // acceptance: "global Kanban is acceptable as a non-empty fallback
  // until the synthetic global Vellum index is implemented").
  if (lastVellumMode === 'find') {
    openGlobalFind()
  } else {
    openGlobalKanban()
  }
}

// Install the real `commitVellumMode` now that `mapChromeBar` is live;
// see the early forward declaration above the open paths for why this
// lands here instead of next to the open functions.
commitVellumMode = (mode) => {
  mapChromeBar.syncMode(mode)
  if (mode) lastVellumMode = mode
  // Stage J — every mode change is a navigation; mirror it into the URL
  // fragment. The bubble-phase hotkey handlers (`v` / `k`) and the
  // chrome-bar mode chips both call commitVellumMode + handle.setMode for
  // in-place tab flips; pushing here covers the in-place path without
  // re-instrumenting every call site. The dedicated open paths
  // (openCityWorkspace etc.) push their own URL too — both calls converge
  // on the same state so the second push no-ops.
  pushCurrentUrl()
}

// State
let cities: City[] = []
let sessions: Session[] = []
let origins: ServerOrigin[] = []
let selectedHex: { q: number; r: number } | null = null
let mapActions: FrontendMapActions | null = null

// Stage G of constitution-portolan-navigation-layer: HTTP base for the
// recents endpoints. Tracks `window.location.hostname` so dev-server
// proxying works (matches FindHost's API_BASE pattern, which derives the
// same way).
const PORTOLAN_HTTP_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

/**
 * Stage G — fire-and-forget recents touch from the open paths in this
 * module (openFile, openCityWorkspace). The mountContext exposes the
 * same call to FindHost; this helper hits the same endpoint so map-hex
 * clicks, URL-hash restores, and any other in-host open route also
 * accrete recents without prop-threading the mountContext.
 *
 * Files use city-relative paths so the entry survives moving the city
 * directory across machines (matches the agent path on the server side
 * — see server's relativeToCity). Falls back to the absolute path if
 * the file lives outside the city root, which can happen when the user
 * hand-passes a system path.
 */
function recordRecentTouch(args: {
  kind: 'fiber' | 'file'
  cityId: string
  originId?: string
  path: string
}): void {
  if (!args.cityId || !args.path) return
  const city = cities.find(c => c.id === args.cityId)
  const originId = args.originId ?? city?.originId ?? 'local'
  let path = args.path
  if (args.kind === 'file' && city) {
    const cityRoot = city.path.endsWith('/') ? city.path : `${city.path}/`
    if (path.startsWith(cityRoot)) path = path.slice(cityRoot.length)
  }
  void fetch(`${PORTOLAN_HTTP_BASE}/recents/touch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      viewerKind: 'human',
      viewerId: 'human',
      originId,
      cityId: args.cityId,
      kind: args.kind,
      path,
    }),
  }).catch(err => console.debug('[recents] touch failed:', err))
}

// Promise-wrapped WS-listDirectory client. FindHost's Files column
// (Stage E of constitution-portolan-navigation-layer) needs an awaitable
// directory listing API. The client observes the WS `directoryListing`
// messages and drains pending FindHost promises. Stage I retired the
// legacy `CityHUDFileTree` co-consumer, so this is the only handler now.
const directoryListingClient = new DirectoryListingClient()

// Register portolan state getters with the vellum mount layer so the
// annotation-action handlers (send-to-worker, save-as-fiber) can resolve a
// worker session and city path for any open file. See annotation-actions.
void vellumMountPromise.then(({ setPortolanMountContext }) => {
  setPortolanMountContext({
    getSessions: () => sessions,
    getCities: () => cities,
    requestDirectoryListing: (cityId, path) =>
      directoryListingClient.request(cityId, path),
    openFile: (args) => openFile(args),
    // Stage G of constitution-portolan-navigation-layer: wrap POST
    // /recents/touch as a getter so any FindHost / openFile / openCityWorkspace
    // open path that resolves a (cityId, fiber|file path) feeds the SQLite
    // recents store. Fire-and-forget — the server tolerates missing
    // sqlite (returns enabled:false) and a failed write doesn't block the
    // user's navigation.
    recordRecentView: ({ kind, path, cityId, originId }) => {
      const resolvedOriginId = originId
        ?? cities.find(c => c.id === cityId)?.originId
        ?? 'local'
      void fetch(`${PORTOLAN_HTTP_BASE}/recents/touch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          viewerKind: 'human',
          viewerId: 'human',
          originId: resolvedOriginId,
          cityId,
          kind,
          path,
        }),
      }).catch(err => {
        // Recents is best-effort: log at debug level so a transient
        // server outage doesn't spam the console.
        console.debug('[recents] touch failed:', err)
      })
    },
    getRecents: async ({ cityId, limit = 8 } = {}) => {
      const params = new URLSearchParams()
      if (cityId) params.set('cityId', cityId)
      params.set('limit', String(limit))
      try {
        const res = await fetch(`${PORTOLAN_HTTP_BASE}/recents?${params}`)
        if (!res.ok) return []
        const body = await res.json() as { entries?: unknown }
        return Array.isArray(body.entries) ? body.entries as Array<{
          originId: string
          cityId: string
          kind: 'fiber' | 'file'
          path: string
          lastViewedAt: number
          viewCount: number
          viewerKinds: Array<'human' | 'agent'>
        }> : []
      } catch (err) {
        console.debug('[recents] fetch failed:', err)
        return []
      }
    },
  })
})

// Move mode: when set, next click will move this city to that hex
let movingCityId: string | null = null

const stateSync = new FrontendStateSync({
  // Stage I — `DirectoryListingClient` is the only consumer of
  // `directoryListing` messages; the CityHUDFileTree co-handler retired
  // alongside the rest of the HUD. The panel-handler return value is
  // informational only.
  handlePanelMessage: (message) => directoryListingClient.handleMessage(message),
  onSocketOpen: (socket) => {
    directoryListingClient.setWebSocket(socket)
  },
  onStateChange: ({ cities: nextCities, sessions: nextSessions, origins: nextOrigins, activityBySessionKey, meetingBridge: _meetingBridge, isInitialState, urlState }) => {
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

    // Stage I — `meetingBridge` is still tracked in `FrontendStateSync`
    // (so a future Meetings home can pick it up without a server-side
    // change) but no UI surface renders it now that the HUD retired. The
    // map chrome bar carries workers + glance only; meetings are an
    // explicit known-orphaned affordance until either Find or the chrome
    // bar grows a section for them.
    mapChromeBar.update(cities, sessions)

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

    // Stage J — full URL-fragment-driven cold-load. `applyUrlState` reads
    // the URL and converges the UI; the most-recent-city fallback only
    // applies when there's no city in the URL. The `?city=X` / `#city=X`
    // legacy precedence (URL wins over most-recent) survives via
    // applyUrlState's first branch.
    const urlCity = urlState?.cityId ? resolveCityFromUrlId(urlState.cityId) : null
    const targetCity = urlCity || mostRecentCity || cities[0]
    console.log(
      '[InitialFocus]',
      urlCity ? `URL: ${targetCity.name}` : mostRecentCity ? `Most recent: ${targetCity.name}` : `Fallback: ${targetCity.name}`,
      sessions.length,
      'sessions,',
      sessions.filter(s => s.cityId).length,
      'with cityId',
      urlState?.mode ? `mode=${urlState.mode}` : '',
    )
    // Stage J — wrap initial-load convergence in suppressed mode so the
    // intermediate URL writes (handleCityClick → city-only URL) don't
    // overwrite the mode/fiber/scope/file the user actually asked for via
    // the typed deep link. applyUrlState's internal runSuppressed nests
    // fine; both layers share the depth counter.
    void urlSync.runSuppressed(async () => {
      handleCityClick(targetCity)
      if (urlState && (urlState.mode || urlState.fiberSlug || urlState.filePath)) {
        await applyUrlState(urlState, { cities, fallbackCity: targetCity })
      }
    })
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

/**
 * Stage J — converge the UI to a target URL state. Called from:
 *   - `onStateChange`'s initial-load branch (cold load deep link)
 *   - the `popstate` handler (browser back/forward)
 *   - the `hashchange` listener (user types a hash URL into the address bar)
 *
 * The function reads the live module-state (`activeWorkspaceHandle`,
 * `lastFocusedCityId`, …), diffs against `target`, and dispatches the
 * minimum set of opens / closes / setMode flips needed to land the UI in
 * the target state. The whole thing runs inside `urlSync.runSuppressed`
 * so the open paths' incidental URL pushes don't try to write the URL
 * we're already reconciling against.
 *
 * Diff rules (mode-first, then fiber/file/scope, then city):
 *   - mode missing in URL + modal open → close
 *   - mode set in URL + modal closed → open with full state
 *   - same mode + same fiber/file/scope: setMode no-op (URL was idempotent)
 *   - same mode + different fiber/file/scope: close + reopen (fiber-navigate
 *     isn't exposed via VellumModalHandle yet; close + reopen is the
 *     cheapest unambiguous reset and preserves Stage J's quality bar at
 *     the cost of a brief flicker — refining via apiRef-exposed navigate
 *     is a future stage)
 *   - different mode + same scope/fiber: setMode in place
 *   - different mode + different fiber: close + reopen
 *   - city in URL ≠ lastFocusedCityId: handleCityClick, then settle modal
 *
 * The fallback path (`urlState.fiberSlug` set with no `urlState.cityId`)
 * resolves city via `/fiber-locate`; we await it before opening the modal
 * so the camera + scope land together.
 */
async function applyUrlState(
  target: UrlState,
  opts: { cities?: City[]; fallbackCity?: City | null } = {},
): Promise<void> {
  const liveCities = opts.cities ?? cities
  if (liveCities.length === 0) return // wait for InitialFocus

  await urlSync.runSuppressed(async () => {
    // Resolve the city the URL is pointing at. May be unset (global modal
    // or just-the-fiber URL) — we then ask the server which city owns the
    // fiber.
    let targetCity: City | null = target.cityId
      ? resolveCityFromUrlId(target.cityId)
      : null

    if (!targetCity && target.fiberSlug) {
      const hit = await resolveFiberCity(target.fiberSlug, liveCities)
      if (hit) targetCity = hit
    }
    // Fallback for bare-`#city=X` URLs whose city no longer resolves —
    // keep the camera where it was rather than blanking out.
    if (!targetCity && target.cityId) {
      console.warn('[applyUrlState] #city=', target.cityId, 'not found in any local or remote city')
    }

    // Camera focus first — handleCityClick is idempotent on same-city.
    const focusCity = targetCity ?? opts.fallbackCity ?? null
    if (focusCity && lastFocusedCityId !== focusCity.id) {
      handleCityClick(focusCity)
    }

    // Resolve the modal-scope city for openCityWorkspace's initialScope:
    // explicit `&scope=cityId` overrides the inherited cityId; `&scope=global`
    // means "explicit global override" (the modal's own cityId stays — the
    // user is on Find at city X, scoped to global).
    const scopeOverride: string | typeof SCOPE_GLOBAL | undefined =
      target.scopeCityId ?? undefined

    // Modal-state diff. The current state is what `buildCurrentUrlState`
    // would emit; cheaper to read directly off the live vars.
    const currentMode: VellumMode | null = activeWorkspaceHandle ? lastVellumMode : null
    const sameMode = currentMode === (target.mode ?? null)
    const sameFiber = (activeWorkspaceFiberSlug ?? null) === (target.fiberSlug ?? null)
    const sameFile = (activeWorkspaceFilePath ?? null) === (target.filePath ?? null)
    const sameScope = (activeWorkspaceScopeOverride ?? null) === (target.scopeCityId ?? null)
    const sameCity = (activeWorkspaceCityId ?? null) === (targetCity?.id ?? null)

    if (sameMode && sameFiber && sameFile && sameScope && sameCity) {
      return // nothing to do
    }

    // Mode missing → close any open modal.
    if (!target.mode) {
      if (activeWorkspaceHandle) {
        const handle = activeWorkspaceHandle
        activeWorkspaceHandle = null
        handle.close()
      }
      return
    }

    // Mode set. Decide setMode-in-place vs close+reopen. We can flip in
    // place only when the modal is open AND the fiber/file/scope/city
    // already match the target — otherwise we tear down so the new
    // adapter / scope / fiber surface comes up with consistent state.
    const canFlipInPlace =
      activeWorkspaceHandle != null
      && sameFiber
      && sameFile
      && sameScope
      && sameCity
    if (canFlipInPlace && !sameMode) {
      commitVellumMode(target.mode)
      activeWorkspaceHandle?.setMode(target.mode)
      return
    }

    // Close + reopen path. The reopen branches mirror openGlobalFind /
    // openGlobalKanban / openCityWorkspace / openFile in main.ts.
    if (activeWorkspaceHandle) {
      const handle = activeWorkspaceHandle
      activeWorkspaceHandle = null
      handle.close()
    }

    if (target.filePath) {
      // File mode lives in narrative; cityId optional.
      openFile({
        path: target.filePath,
        cityId: targetCity?.id,
        originId: targetCity?.originId,
      })
      return
    }

    if (target.mode === 'kanban' && (!targetCity || scopeOverride === SCOPE_GLOBAL)) {
      openGlobalKanban()
      return
    }
    if (target.mode === 'find' && (!targetCity || scopeOverride === SCOPE_GLOBAL)) {
      openGlobalFind()
      return
    }
    if (targetCity) {
      openCityWorkspace(targetCity, {
        initialSlug: target.fiberSlug,
        initialMode: target.mode,
        initialScope: scopeOverride,
      })
    }
  })
}

/* ─────────────────────────────────────────────────────────────────────────
 * Stage J — bind URL events. `popstate` (browser back/forward) and
 * `hashchange` (user-typed hash URL) both converge through `applyUrlState`.
 * ────────────────────────────────────────────────────────────────────── */
urlSync.setPopHandler((state) => {
  void applyUrlState(state)
})
window.addEventListener('hashchange', () => {
  void applyUrlState(urlSync.read())
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
    // Stage I — deep-press is the surviving primary affordance for
    // playgrounds (the CityHUD's "View Playgrounds" button retired). Cities
    // with claims open vellum's narrative on the city; cities without
    // claims (so the deep-press has no fiber graph to surface) fall to
    // the playground viewer if they have one. The screening for
    // `hasClaims || hasPlaygrounds` happens upstream in
    // `MapInteractionController.onCanvasForceDown` — we only see cities
    // that pass that gate.
    if (city.hasClaims) {
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
})

const isEditableElement = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  const tagName = element.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

/* ────────────────────────────────────────────────────────────────────── *
 * Hotkeys (Stage K — constitution-portolan-navigation-layer §"Hotkey
 * scheme: v / k / / and //").
 *
 * Two declarative `tinykeys` binding maps: one at capture phase on
 * `document` for `/` (beats vellum's bubble-phase `/` handler that focuses
 * its in-collection thumb-index search), and one at bubble phase on
 * `window` for the rest (`v`, `k`, `n`) where there is no listener
 * conflict. The capture/bubble split is the only place phase still
 * matters; otherwise tinykeys handles modifier-state matching for us.
 *
 * Why each hotkey behaves the way it does is documented at its handler.
 * Common to all of them: bail when typing into an editable element. (The
 * Stage K-era `globalSearchPalette.isVisible()` check retired in Stage C+E
 * along with the legacy `/` palette; the HUD-visibility check retired in
 * Stage I along with the rest of CityHUD.)
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Resolve "the city the hotkey should act on." Stage I — the CityHUD
 * retired, so this is just the most-recently-focused-city lookup. A hex
 * click sets `lastFocusedCityId` (without summoning anything), and that's
 * what `v` / `k` / `/` act on when no vellum is open.
 */
const resolveFocusedCity = (): City | null => {
  if (!lastFocusedCityId) return null
  return cities.find(c => c.id === lastFocusedCityId) ?? null
}

/**
 * Escalate one rung up the Find scope ladder: city → global → close. Used
 * by both the bare `/` handler (when vellum is on Find at city scope) and
 * the `// chord` (when the search input is focused but empty).
 *
 * Capture `activeWorkspaceCityId` *before* `handle.close()` fires:
 * `onClose` (i.e. `handleWorkspaceClosed`) synchronously zeroes both
 * `activeWorkspaceHandle` and `activeWorkspaceCityId`, so reading after
 * the close would always see `null` and we'd skip the openGlobalFind()
 * branch — flatlining the city → global step into city → close.
 */
const escalateFindScope = (): void => {
  const handle = activeWorkspaceHandle
  if (!handle) return
  const wasCityScoped = activeWorkspaceCityId !== null
  // Stage J — when escalating city → global, the close is a transition
  // (followed by openGlobalFind), so suppress the transient
  // "vellum-closed" URL push. When already on global, this is a real
  // close and we want the URL push.
  modalReopenInProgress = wasCityScoped
  handle.close()
  modalReopenInProgress = false
  activeWorkspaceHandle = null
  activeWorkspaceCityId = null
  if (wasCityScoped) {
    openGlobalFind()
    return
  }
  // Was already on global Find — close drops out to the map.
}

/**
 * `/` — scope-step ladder + `// chord` for the Find tab. Bound at capture
 * on `document` so we own the keystroke before vellum's FiberPage handler
 * (which focuses the in-collection thumb-index search). Once we decide to
 * act we `stopImmediatePropagation` so vellum never sees the press.
 *
 * Behaviour by current state:
 *
 *   ┌────────────────────────────────────────┬────────────────────────────┐
 *   │ active element                         │ action                     │
 *   ├────────────────────────────────────────┼────────────────────────────┤
 *   │ Find search input, has text            │ no-op (types literally)    │
 *   │ Find search input, empty               │ escalate scope (// chord)  │
 *   │ any other editable element             │ no-op (let it type)        │
 *   ├────────────────────────────────────────┼────────────────────────────┤
 *   │ vellum closed, focused city X          │ openCityWorkspace(X, find) │
 *   │ vellum closed, no focused city         │ openGlobalFind()           │
 *   │ vellum open, not on Find tab           │ handle.setMode('find')     │
 *   │ vellum open on Find, input not focused │ dispatch focus-search evt  │
 *   └────────────────────────────────────────┴────────────────────────────┘
 *
 * The `// chord` is implemented inline rather than via tinykeys' sequence
 * machinery: the second `/` is only special *because the input is focused
 * and empty*, which depends on DOM state, not on a timed key sequence.
 */
const handleSlashHotkey = (event: KeyboardEvent): void => {
  const active = document.activeElement
  if (
    active instanceof HTMLInputElement
    && active.classList.contains(FIND_SEARCH_INPUT_CLASS)
  ) {
    if (active.value.length > 0) return // type literally
    event.preventDefault()
    event.stopImmediatePropagation()
    escalateFindScope()
    return
  }

  if (isEditableElement(active)) return

  // Beat vellum's bubble-phase `/` handler (FiberPage thumb-index search).
  // Without stopImmediatePropagation, vellum focuses its in-collection
  // search input *after* we open Find, leaving the user typing into the
  // wrong control.
  event.preventDefault()
  event.stopImmediatePropagation()

  const handle = activeWorkspaceHandle
  if (!handle) {
    const focusedCity = resolveFocusedCity()
    if (focusedCity) {
      openCityWorkspace(focusedCity, { initialMode: 'find' })
    } else {
      openGlobalFind()
    }
    return
  }

  if (handle.getMode() !== 'find') {
    commitVellumMode('find')
    handle.setMode('find')
    return
  }

  // Vellum already on Find but the input isn't focused. Ask FindHost to
  // focus + select it; the `// chord` (input empty + another `/`) lives in
  // the `active.classList.contains(FIND_SEARCH_INPUT_CLASS)` branch above.
  window.dispatchEvent(new Event(FIND_FOCUS_SEARCH_EVENT))
}

/**
 * Common preflight for the bubble-phase hotkeys (`v`, `k`, `n`, `t`).
 * Returns true to abort the hotkey (keep the event flowing untouched);
 * the caller handles `event.preventDefault()` itself when it acts.
 *
 * Stage K had a `globalSearchPalette.isVisible()` short-circuit here for
 * the legacy `/` palette overlay; that palette retired in Stage C+E
 * along with the rest of `GlobalSearchPalette` (the search lives in
 * vellum's Find tab now). `isEditableElement` covers the remaining case:
 * focus inside vellum's own search input — typing 'v' there shouldn't
 * flip the modal mode.
 */
const shouldSkipBubbleHotkey = (): boolean => {
  if (isEditableElement(document.activeElement)) return true
  return false
}

/** `v` — open / flip-to / close the Narrative tab on the focused city. The
 *  full-semantics replacement for `t` (`t` retired in Stage H per the
 *  constitution's "Hotkey scheme: v / k / / and //"). */
const handleNarrativeHotkey = (event: KeyboardEvent): void => {
  if (shouldSkipBubbleHotkey()) return
  event.preventDefault()
  const handle = activeWorkspaceHandle
  if (handle) {
    if (handle.getMode() === 'narrative') {
      handle.close()
      activeWorkspaceHandle = null
      activeWorkspaceCityId = null
      // handleWorkspaceClosed (via opts.onClose) already syncs the chrome
      // bar to null; nothing extra to do here.
    } else {
      commitVellumMode('narrative')
      handle.setMode('narrative')
    }
    return
  }
  const focusedCity = resolveFocusedCity()
  if (!focusedCity) return
  openCityWorkspace(focusedCity, { initialMode: 'narrative' })
}

/** `k` — Kanban tab toggle. Stage I — per-city scope follows from focus
 *  (the chrome bar's K chip and this hotkey share semantics): a focused
 *  city → K opens kanban scoped to it; no focused city → global. Mirrors
 *  `v`'s focused-city-aware open path. */
const handleKanbanHotkey = (event: KeyboardEvent): void => {
  if (shouldSkipBubbleHotkey()) return
  event.preventDefault()
  const handle = activeWorkspaceHandle
  if (!handle) {
    const focusedCity = resolveFocusedCity()
    if (focusedCity) {
      openCityWorkspace(focusedCity, { initialMode: 'kanban' })
    } else {
      openGlobalKanban()
    }
    return
  }
  if (handle.getMode() === 'kanban') {
    handle.close()
    activeWorkspaceHandle = null
    // handleWorkspaceClosed (via opts.onClose) syncs chrome bar mode to
    // null and refreshes the awaiting-review badge.
  } else {
    commitVellumMode('kanban')
    handle.setMode('kanban')
  }
}

/** `n` — new worker for the focused city. Stage I — without the HUD,
 *  "focused city" is just `lastFocusedCityId` (set by every hex / label
 *  click). Bails when no city has been focused yet — the prompt has no
 *  obvious target otherwise. */
const handleNewWorkerHotkey = (event: KeyboardEvent): void => {
  if (shouldSkipBubbleHotkey()) return
  const focusedCity = resolveFocusedCity()
  if (!focusedCity) return
  event.preventDefault()
  void mapActions?.promptNewWorker(focusedCity)
}

// Stage H — `t` is retired. `v` carries the open / flip-to / close
// semantics for the narrative tab; constitution §"Hotkey scheme" §"`t` is
// removed in Stage H".

const unbindSlashHotkey = tinykeys(
  document,
  { '/': handleSlashHotkey },
  { capture: true },
)
const unbindBubbleHotkeys = tinykeys(window, {
  v: handleNarrativeHotkey,
  k: handleKanbanHotkey,
  n: handleNewWorkerHotkey,
})

let lastCameraRevision = camera.cameraRevision

const appRuntime = new FrontendAppRuntime({
  renderer,
  scene,
  labelRenderer,
  camera,
  zoneRenderer,
  stateSync,
  mapInteractions,
  contextMenu,
  newWorkerDialog,
  playgroundViewer,
  clearArtifactMediaCaches,
  getCities: () => cities,
  // Stage I — workers used to be re-rendered onto the HUD whenever a
  // worker activity event arrived. Without the HUD, the chrome bar's
  // worker-bird strip is the only worker UI; it picks up changes via the
  // `mapChromeBar.update(cities, sessions)` call in the onStateChange
  // path above, which already runs whenever sessions change.
  updateWorkerHud: () => mapChromeBar.update(cities, sessions),
  isWorkerHudVisible: () => true,
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
    unbindSlashHotkey()
    unbindBubbleHotkeys()
    mapChromeBar.dispose()
    appRuntime.dispose()
  })
}
