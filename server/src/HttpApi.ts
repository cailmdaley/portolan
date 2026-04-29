/**
 * HttpApi - HTTP request handlers
 *
 * Handles non-WebSocket HTTP endpoints:
 * - Tapestry DAG (fibers, evidence, staleness)
 * - Evidence artifact serving
 * - Annotation CRUD
 * - City activation (start remote agent)
 */

import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import type { City } from './CityManager.js';
import type { Origin } from './OriginManager.js';
import type { AnnotationPersistence } from './AnnotationPersistence.js';
import type { Session } from './SessionTracker.js';
import type { RecentFileTracker } from './RecentFileTracker.js';
import { HttpApiActivation } from './HttpApiActivation.js';
import { HttpApiAnnotations } from './HttpApiAnnotations.js';
import { HttpApiAstraView } from './HttpApiAstraView.js';
import { HttpApiFileContent } from './HttpApiFileContent.js';
import { HttpApiHooksRuntime } from './HttpApiHooksRuntime.js';
import { HttpApiKanban, type KanbanTarget } from './HttpApiKanban.js';
import type { FiberTreeSnapshot } from './FiberTreeSnapshotStore.js';
import { HttpApiMeeting } from './HttpApiMeeting.js';
import { HttpApiLayouts } from './HttpApiLayouts.js';
import { HttpApiPlayground } from './HttpApiPlayground.js';
import { HttpApiTapestry } from './HttpApiTapestry.js';
import { LayoutStore } from './LayoutStore.js';
import type { MeetingBridge } from './MeetingBridge.js';

// ============================================================================
// Types
// ============================================================================

interface CityLookup {
  getCityById(cityId: string): City | null;
  /** All known cities (used by /fiber-locate to scan for a slug). */
  getCities(): City[];
}

interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface PersistenceLookup {
  getCityById(cityId: string): { sshHost?: string } | null;
  findSshHostForPath(path: string): string | undefined;
  /**
   * Pinned cities, used by the global kanban view to aggregate constitution
   * fibers across every project the user has put on the map — not just the
   * loom monorepo. CityPersistence already exposes this; the interface
   * surfaces it here so the kanban resolver can read pins without
   * reaching past the lookup.
   */
  getCities(): Array<{ id: string; path: string; originId: string }>;
}

interface SessionLookup {
  findSession(sessionId: string): Session | undefined;
  getAllSessions(): Session[];
}

type RuntimeDiagnosticsProvider = () => unknown | Promise<unknown>;

/**
 * Cross-cutting deps that don't fit the lookup-shaped interfaces above.
 * Stage 3a of the vellum-kanban constitution adds the fiber-tree snapshot
 * provider here — the kanban folds remote-origin snapshots into the global
 * view alongside local-host walks. Stage 4 adds the remote-transition
 * executor — `kanban/transition` against a remote-origin card flows through
 * this callback (correlation-ID layer + snapshot-store delta apply) instead
 * of writing the file directly. Both optional so existing tests continue to
 * construct HttpApi without wiring an agent.
 */
export interface HttpApiOptions {
  remoteSnapshotsProvider?: () => FiberTreeSnapshot[];
  remoteTransitionExecutor?: (args: {
    originId: string;
    fiberId: string;
    path: string;
    target: KanbanTarget;
    nowIso: string;
  }) => Promise<void>;
  /**
   * Override felt root for the `/static/.felt/<rest>` asset route. Defaults
   * to `<projectRoot>/.felt`; tests inject an isolated tmpdir.
   */
  feltRoot?: string;
}

// ============================================================================
// HttpApi
// ============================================================================

export class HttpApi {
  private cityLookup: CityLookup;
  private originLookup: OriginLookup;
  private persistenceLookup: PersistenceLookup;
  private annotationsApi: HttpApiAnnotations;
  private astraViewApi: HttpApiAstraView;
  private fileContentApi: HttpApiFileContent;
  private hooksRuntimeApi: HttpApiHooksRuntime;
  private kanbanApi: HttpApiKanban;
  private meetingApi: HttpApiMeeting;
  private activationApi: HttpApiActivation;
  private playgroundApi: HttpApiPlayground;
  private tapestryApi: HttpApiTapestry;
  private layoutsApi: HttpApiLayouts;
  private layoutStore: LayoutStore;
  private remoteSnapshotsProvider: (() => FiberTreeSnapshot[]) | undefined;
  private remoteTransitionExecutor: HttpApiOptions['remoteTransitionExecutor'];

  constructor(
    cityLookup: CityLookup,
    originLookup: OriginLookup,
    persistenceLookup: PersistenceLookup,
    options: HttpApiOptions = {},
  ) {
    this.cityLookup = cityLookup;
    this.originLookup = originLookup;
    this.persistenceLookup = persistenceLookup;
    this.remoteSnapshotsProvider = options.remoteSnapshotsProvider;
    this.remoteTransitionExecutor = options.remoteTransitionExecutor;
    this.annotationsApi = new HttpApiAnnotations({
      cityLookup,
      originLookup,
      getSshHost: (city) => this.getSshHost(city),
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    this.fileContentApi = new HttpApiFileContent({
      originLookup,
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
      feltRoot: options.feltRoot,
    });
    this.astraViewApi = new HttpApiAstraView({ originLookup });
    this.kanbanApi = new HttpApiKanban({
      remoteSnapshotsProvider: this.remoteSnapshotsProvider,
      remoteTransitionExecutor: this.remoteTransitionExecutor,
    });
    this.hooksRuntimeApi = new HttpApiHooksRuntime({
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    this.meetingApi = new HttpApiMeeting({
      originLookup,
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    this.activationApi = new HttpApiActivation({
      cityLookup,
      getSshHost: (city) => this.getSshHost(city),
    });
    this.playgroundApi = new HttpApiPlayground({
      cityLookup,
      getSshHost: (city) => this.getSshHost(city),
    });
    this.tapestryApi = new HttpApiTapestry({
      cityLookup,
      fileContentApi: this.fileContentApi,
      getSshHost: (city) => this.getSshHost(city),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    // After both APIs exist, link them so a successful /file-as-fiber
    // invalidates the tapestry's fiber-list cache. Without this, the 30s
    // TTL would hide a freshly-created child fiber from /astra/graph and
    // /api/search until expiry. Couldn't be wired in HttpApiAnnotations'
    // construction above — tapestryApi didn't exist yet.
    this.annotationsApi.setOnFiberCreated((cityPath, sshHost) => {
      this.tapestryApi.invalidateFiberListCache(cityPath, sshHost);
    });
    this.layoutStore = new LayoutStore();
    this.layoutsApi = new HttpApiLayouts({
      layoutStore: this.layoutStore,
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
      cityLookup,
    });
  }

  /**
   * Set annotation persistence instance
   */
  setAnnotationPersistence(persistence: AnnotationPersistence): void {
    this.annotationsApi.setAnnotationPersistence(persistence);
  }

  /**
   * Set session lookup instance
   */
  setSessionLookup(lookup: SessionLookup): void {
    this.annotationsApi.setSessionLookup(lookup);
    this.meetingApi.setSessionLookup(lookup);
  }

  /**
   * Set recent file tracker for worker hover tooltips
   */
  setRecentFileTracker(tracker: RecentFileTracker): void {
    this.hooksRuntimeApi.setRecentFileTracker(tracker);
  }

  /**
   * Set runtime diagnostics provider for /debug-runtime endpoint.
   */
  setRuntimeDiagnosticsProvider(provider: RuntimeDiagnosticsProvider): void {
    this.hooksRuntimeApi.setRuntimeDiagnosticsProvider(provider);
  }

  setMeetingBridge(bridge: MeetingBridge): void {
    this.meetingApi.setMeetingBridge(bridge);
  }

  setOnCreateNewWorker(fn: (cityPath: string, originId: string) => Promise<string>): void {
    this.annotationsApi.setOnCreateNewWorker(fn);
  }

  setOnFocusSession(fn: (sessionId: string) => void): void {
    this.annotationsApi.setOnFocusSession(fn);
  }

  /**
   * Handle HTTP request - returns true if handled, false to fall through
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Handle CORS preflight for all HTTP methods
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return true;
    }

    if (url.pathname === '/tapestry') {
      await this.tapestryApi.handleTapestry(url, res);
      return true;
    }

    if (url.pathname === '/astra/graph') {
      await this.tapestryApi.handleAstraGraph(url, res);
      return true;
    }

    if (url.pathname === '/city-root-slug') {
      await this.tapestryApi.handleCityRootSlug(url, res);
      return true;
    }

    // Must precede `/fiber/` prefix match — the literal `/fiber-locate`
    // path is unrelated to the fiber content endpoint.
    if (url.pathname === '/fiber-locate' && req.method === 'GET') {
      await this.tapestryApi.handleFiberLocate(url, res);
      return true;
    }

    if (url.pathname === '/api/search' && req.method === 'GET') {
      await this.tapestryApi.handleSearch(url, res);
      return true;
    }

    if (url.pathname === '/kanban' && req.method === 'GET') {
      const kanbanApi = this.resolveKanbanApi(url, res);
      if (!kanbanApi) return true; // error response already sent
      await kanbanApi.handleKanban(url, res);
      return true;
    }

    if (url.pathname === '/kanban/transition' && req.method === 'POST') {
      const kanbanApi = this.resolveKanbanApi(url, res);
      if (!kanbanApi) return true; // error response already sent
      await kanbanApi.handleTransition(req, res);
      return true;
    }

    // POST /fiber/create — vellum's stash button (constitution-stash-button).
    // Must precede the `/fiber/` prefix match below; otherwise it routes to
    // handleFiberContent and returns "Missing cityId parameter".
    if (url.pathname === '/fiber/create' && req.method === 'POST') {
      await this.annotationsApi.handleCreateFiber(req, res);
      return true;
    }

    if (url.pathname.startsWith('/fiber/')) {
      const slug = decodeURIComponent(url.pathname.slice('/fiber/'.length));
      await this.tapestryApi.handleFiberContent(url, slug, res);
      return true;
    }

    if (url.pathname.startsWith('/tapestry-asset/')) {
      await this.tapestryApi.handleTapestryAsset(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/activate-city') {
      await this.activationApi.handleActivateCity(url, res);
      return true;
    }

    if (url.pathname === '/file-content') {
      await this.fileContentApi.handleFileContent(url, res);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/project-file/')) {
      await this.fileContentApi.handleProjectFile(url, res);
      return true;
    }

    // Inline-image asset channel for fiber markdown:
    // `![alt](/static/.felt/<rest>)` resolves to `<projectRoot>/.felt/<rest>`.
    // Predates tapestry retirement; restored after commit 5755034 removed the
    // static-viewer Vite config that incidentally served this prefix. See
    // `vellum-reader/constitution-restore-static-felt-route` + sibling gotcha.
    if (req.method === 'GET' && url.pathname.startsWith('/static/.felt/')) {
      await this.fileContentApi.handleStaticFeltAsset(url, res);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/astra-paper-view/')) {
      await this.astraViewApi.handlePaperView(url, res);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/astra-bundle/')) {
      await this.astraViewApi.handleBundle(url, res);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/astra-mtime/')) {
      await this.astraViewApi.handleMtime(url, res);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/astra/asset/')) {
      await this.astraViewApi.handleAsset(url, res);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/papers/')) {
      await this.astraViewApi.handlePaperPdf(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/save-file') {
      await this.fileContentApi.handleSaveFile(req, res);
      return true;
    }

    // Annotation endpoints
    if (url.pathname === '/annotations' && req.method === 'GET') {
      await this.annotationsApi.handleGetAnnotations(url, res);
      return true;
    }

    if (url.pathname === '/recent-annotations' && req.method === 'GET') {
      await this.annotationsApi.handleRecentAnnotations(url, res);
      return true;
    }

    if (url.pathname === '/annotations' && req.method === 'POST') {
      await this.annotationsApi.handleCreateAnnotation(req, res);
      return true;
    }

    if (url.pathname.match(/^\/annotations\/[^/]+$/) && req.method === 'PUT') {
      const id = url.pathname.split('/')[2];
      await this.annotationsApi.handleUpdateAnnotation(id, req, res);
      return true;
    }

    if (url.pathname.match(/^\/annotations\/[^/]+$/) && req.method === 'DELETE') {
      const id = url.pathname.split('/')[2];
      await this.annotationsApi.handleDeleteAnnotation(id, res);
      return true;
    }

    if (url.pathname === '/send-annotations' && req.method === 'POST') {
      await this.annotationsApi.handleSendAnnotations(req, res);
      return true;
    }

    if (url.pathname === '/file-as-fiber' && req.method === 'POST') {
      await this.annotationsApi.handleFileAsFiber(req, res);
      return true;
    }

    if (url.pathname === '/promote-to-felt' && req.method === 'POST') {
      await this.annotationsApi.handlePromoteToFelt(req, res);
      return true;
    }

    if (url.pathname.startsWith('/layouts/')) {
      const handled = await this.layoutsApi.handle(url, req, res);
      if (handled) return true;
    }

    if (url.pathname === '/playground-list') {
      await this.playgroundApi.handlePlaygroundList(url, res);
      return true;
    }

    if (url.pathname === '/playground') {
      await this.playgroundApi.handlePlayground(url, res);
      return true;
    }

    if (url.pathname === '/recent-files' && req.method === 'GET') {
      await this.hooksRuntimeApi.handleRecentFiles(url, res);
      return true;
    }

    if (url.pathname === '/debug-runtime') {
      await this.hooksRuntimeApi.handleDebugRuntime(res);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/meeting-bridge') {
      this.meetingApi.handleGetState(res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/start') {
      await this.meetingApi.handleStart(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/stop') {
      this.meetingApi.handleStop(res);
      return true;
    }

    return false;
  }

  /**
   * Resolve which HttpApiKanban instance handles a /kanban[/transition] request
   * based on optional `?cityId=` scoping. Returns null after writing a 4xx
   * response if the scope can't be honored.
   *
   *   - No `cityId` query param → *global view*, aggregating over every
   *     pinned local-origin city from `~/.portolan/cities.json`. Constructed
   *     fresh per request so newly-pinned cities show up immediately;
   *     `HttpApiKanban` dedupes by realpath, so a fiber that appears in both
   *     loom and a project city (because the project's `.felt/` is symlinked
   *     into loom) renders once. Falls back to the legacy loom-only shared
   *     instance if no cities are pinned (covers first-run before any pins
   *     and tests).
   *   - `cityId` resolves to a local-origin city → per-request HttpApiKanban
   *     scoped to that city's path. New instance per request is fine; the
   *     class is stateless beyond construction options and reads on demand.
   *   - `cityId` resolves to a remote-origin city → 400. Stage 1 of the
   *     vellum-kanban constitution is local-origin only; remote-origin
   *     scoping unlocks once the agent fiber-tree push protocol lands
   *     (Stage 3). See ai-futures/portolan/vellum-reader/constitution-vellum-kanban.
   *   - Unknown `cityId` → 400.
   */
  private resolveKanbanApi(url: URL, res: ServerResponse): HttpApiKanban | null {
    const cityId = url.searchParams.get('cityId');
    // Pinned local cities, threaded into HttpApiKanban so each card carries
    // its owning cityId + project-relative slug. Without this, the global
    // kanban emits loom-relative ids (`ai-futures/portolan/...`) that don't
    // match anything in a project-scoped vellum collection — clicking a
    // card lands on vellum's "not found" page. Cheap to compute per
    // request: the kanban memoizes the realpath table internally per
    // instance, and we build a fresh instance per request anyway.
    const localCities = this.persistenceLookup
      .getCities()
      .filter(c => c.originId === 'local')
      .map(c => ({ id: c.id, path: c.path }));
    if (!cityId) {
      const localPins = localCities.map(c => c.path);
      if (localPins.length === 0) return this.kanbanApi;
      // Global view: pinned local hosts + every remote origin's pushed
      // snapshot (Stage 3a). HttpApiKanban dedupes id-collisions between
      // local and remote, with local winning — local-mirrors-of-remote
      // (e.g. an rsynced loom) render as one card sourced from local.
      // Stage 4: remote-origin transitions go through the executor.
      return new HttpApiKanban({
        feltHosts: localPins,
        cities: localCities,
        remoteSnapshotsProvider: this.remoteSnapshotsProvider,
        remoteTransitionExecutor: this.remoteTransitionExecutor,
      });
    }
    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 400, `unknown cityId: ${cityId}`);
      return null;
    }
    if (city.originId !== 'local') {
      // Stage 3a lands the *global* view for remote origins. Per-city
      // remote scoping needs the agent to walk multiple feltHosts and
      // ship per-city snapshots (or the server to filter by city.path
      // → id-prefix), neither of which is in the Stage 3a ambit.
      // See [[finding-restaged-implementation-plan]] §3a — the protocol
      // is the unblock; per-city remote scoping is a follow-up.
      this.sendJsonError(
        res,
        400,
        `cityId=${cityId} resolves to remote origin '${city.originId}'; ` +
          `per-city remote scoping is a Stage 3a follow-up — the global view ` +
          `(no cityId) already aggregates remote origins via agent push`,
      );
      return null;
    }
    return new HttpApiKanban({ feltHost: city.path, cities: localCities });
  }

  /**
   * Get SSH host for a city (from origin or persistence)
   */
  private getSshHost(city: City): string {
    const origin = this.originLookup.getOrigin(city.originId);
    if (origin?.sshHost) return origin.sshHost;
    const persistedCity = this.persistenceLookup.getCityById(city.id);
    if (persistedCity?.sshHost) return persistedCity.sshHost;
    // Fallback: ID-based lookup can fail when CityManager normalizes keys differently
    // from CityPersistence (e.g., remote-c02 vs remote-candide). Search by path.
    const pathSshHost = this.persistenceLookup.findSshHostForPath(city.path);
    if (pathSshHost) return pathSshHost;
    return city.originId.replace('remote-', '');
  }

  private formatAnnotationsForClaude(filePath: string, annotations: unknown[], globalComment?: string): string {
    return this.annotationsApi.formatAnnotationsForClaude(filePath, annotations as any, globalComment);
  }

  private formatClaimsAnnotationsForClaude(cityName: string, annotations: unknown[], globalComment?: string): string {
    return this.annotationsApi.formatClaimsAnnotationsForClaude(cityName, annotations as any, globalComment);
  }

  /**
   * Parse JSON body from request, sending error response if invalid
   */
  private async parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    try {
      return JSON.parse(body) as T;
    } catch {
      this.sendJsonError(res, 400, 'Invalid JSON body');
      return null;
    }
  }

  /**
   * Send JSON error response
   */
  private sendJsonError(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error }));
  }

  /**
   * Send JSON success response
   */
  private sendJsonSuccess(res: ServerResponse, data: Record<string, unknown>): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  }

}
