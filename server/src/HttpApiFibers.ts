import { execFile } from 'child_process';
import { createHash } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'fs';
import { readFile, rename, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import { getAllFibers, mapFeltJsonToFiber, type Fiber } from './FiberReader.js';
import type { FiberTreeSnapshot } from './FiberTreeSnapshotStore.js';
import { HttpApiFileContent } from './HttpApiFileContent.js';
import { markdownToMdast } from './MarkdownToMdast.js';
import { shellEscape } from './ShellPathUtils.js';

const execFileAsync = promisify(execFile);

interface CityLookup {
  getCityById(cityId: string): City | null;
  /** All known cities (used by /fiber-locate to scan for a slug). */
  getCities(): City[];
  /** True iff this cityId is pinned (i.e. surfaces on the kanban / map).
   *  Used by the fiber graph's cross-city augmentation to limit the
   *  __city__ sibling gateways to pinned cities — the same set the
   *  global Vellum index surfaces, so the user navigates a consistent
   *  loom-wide collection across both surfaces. */
  isPinned(cityId: string): boolean;
}

interface HttpApiFibersOptions {
  cityLookup: CityLookup;
  fileContentApi: HttpApiFileContent;
  getSshHost: (city: City) => string;
  remoteSnapshotsProvider?: () => FiberTreeSnapshot[];
  remoteRawFiberExecutor?: (request: RemoteRawFiberInvocation) => Promise<RemoteRawFiberResult>;
  remoteFiberHistoryExecutor?: (request: RemoteFiberHistoryInvocation) => Promise<RemoteFiberHistoryResult>;
  sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;
}

export interface RemoteRawFiberInvocation {
  originId: string;
  feltHost: string;
  path: string;
  operation: 'read' | 'write';
  body?: string;
}

export interface RemoteRawFiberResult {
  body?: string;
  sha256?: string;
}

export interface RemoteFiberHistoryInvocation {
  originId: string;
  feltHost: string;
  slug: string;
}

export interface RemoteFiberHistoryResult {
  events?: unknown[];
}

export class HttpApiFibers {
  private readonly cityLookup: CityLookup;
  private readonly fileContentApi: HttpApiFileContent;
  private readonly getSshHost: (city: City) => string;
  private readonly remoteSnapshotsProvider: (() => FiberTreeSnapshot[]) | undefined;
  private readonly remoteRawFiberExecutor: HttpApiFibersOptions['remoteRawFiberExecutor'];
  private readonly remoteFiberHistoryExecutor: HttpApiFibersOptions['remoteFiberHistoryExecutor'];
  private readonly sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  private readonly sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;

  /**
   * TTL cache for `getAllCityFibers` results. Workspace mounts hit /fiber-graph
   * and /city-root-slug back-to-back; without caching these each pay a fresh
   * `felt ls --json` invocation over SSH, which on remote cities is the
   * single biggest contributor to perceived workspace-open latency. 30s is
   * short enough to feel live (a fiber created via /file-as-fiber appears
   * within half a minute or whenever the cache is invalidated explicitly)
   * and long enough to coalesce the typical workspace open into a single
   * SSH call. Keyed by host + path + body-shape so the metadata path and
   * the body-bearing path don't bleed into each other.
   */
  private fiberListCache = new Map<string, { fibers: Fiber[]; expiresAt: number }>();
  private static readonly FIBER_LIST_TTL_MS = 30_000;

  constructor(options: HttpApiFibersOptions) {
    this.cityLookup = options.cityLookup;
    this.fileContentApi = options.fileContentApi;
    this.getSshHost = options.getSshHost;
    this.remoteSnapshotsProvider = options.remoteSnapshotsProvider;
    this.remoteRawFiberExecutor = options.remoteRawFiberExecutor;
    this.remoteFiberHistoryExecutor = options.remoteFiberHistoryExecutor;
    this.sendJsonError = options.sendJsonError;
    this.sendJsonSuccess = options.sendJsonSuccess;
  }

  /**
   * Drop cached fiber lists for a given city. Callers that mutate the fiber
   * tree (e.g. /file-as-fiber creating a new fiber via `felt add`) should
   * invalidate so the next read reflects the change rather than waiting out
   * the TTL. Invalidates both metadata and body-bearing variants for the
   * given host/path so a search-after-create sees the new fiber too.
   */
  invalidateFiberListCache(cityPath: string, sshHost?: string): void {
    const host = sshHost ?? 'local';
    this.fiberListCache.delete(`${host}::${cityPath}::meta`);
    this.fiberListCache.delete(`${host}::${cityPath}::body`);
  }

  /**
   * /fiber-graph?cityId=X — vellum-shaped FiberGraph (nodes + links).
   *
   * Emits vellum's
   * GraphNode/GraphLink types (see lightcone/vellum/src/utils/content-types.ts).
   * Returns all fibers because Vellum's graph view handles filtering itself.
   *
   * First-pass fields: id, slug, label, status, tags, kind, createdAt.
   * Links default to kind 'data-flow' (from dependsOn), with directory
   * containment links added from fiber slug shape.
   *
   * Cross-city / city-as-parent augmentation
   * ----------------------------------------
   * On top of the city's own fibers, we synthesise the city's place in
   * the loom so the thumb-index nav rail behaves intuitively. Without
   * this the city's root fiber has no parent and no "city contents" view
   * — it sits next to its own subdirectories with neither containment
   * nor cross-city sibling relationships, which surprises any user
   * navigating from the global Vellum index ("I clicked into ai-futures,
   * where are its children?").
   *
   * The augmentation, all *additive* to the existing graph:
   *   - A synthetic `__loom__` parent node, so the city's root fiber has
   *     somewhere to climb upward to. Vellum's parent-row in
   *     FloatingIsland renders this as `← loom`; portolan intercepts the
   *     `__` slug click and routes it to `openGlobalVellumIndex`.
   *   - Contains-link `__loom__` → root fiber, so the root fiber's
   *     parent-row resolves to loom.
   *   - One `__city__:otherCityId` node per *other* city, with
   *     contains-link `__loom__` → that node. They become the root
   *     fiber's siblings via the shared loom parent. Click routes
   *     through the same `__` synthetic-node interception in the host
   *     (remount on the other city in the active mode).
   *   - Contains-links from the root fiber to each *other* top-level
   *     intra-city fiber (slug-shape: no `/` and not the rootSlug
   *     itself). The user's mental model is "the root fiber IS the
   *     city" — so the city's other top-level fibers should hang off
   *     the root fiber as its children, not float as parentless peers.
   *
   * Cities-only augmentation when there's no rootSlug: skip the
   * intra-city + parent links (no anchor to attach them to) and just
   * emit the cross-city nodes so the graph still has cross-city
   * navigation when present.
   */
  async handleFiberGraph(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      this.sendJsonError(res, 400, 'Missing cityId parameter');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return;
    }

    const sshHost = city.originId !== 'local' ? this.getSshHost(city) : undefined;

    try {
      const allFibers = await this.getAllCityFibers(city.path, sshHost);
      const fiberIds = new Set(allFibers.map((fiber) => fiber.id));

      const nodes: Array<{
        id: string;
        slug: string;
        label: string;
        status: string;
        tags: string[];
        kind: string;
        createdAt: string | undefined;
        tempered: boolean;
        hasStructuredData: boolean;
        decisionCount: number;
        findingCount: number;
      }> = allFibers.map((fiber) => ({
        id: fiber.id,
        slug: fiber.id,
        label: fiber.name,
        status: fiber.status,
        tags: fiber.tags ?? [],
        kind: fiber.kind,
        createdAt: fiber.createdAt || undefined,
        tempered: false,
        hasStructuredData: false,
        decisionCount: 0,
        findingCount: 0,
      }));

      const links: Array<{ source: string; target: string; kind: 'data-flow' | 'contains' }> = [];
      for (const fiber of allFibers) {
        for (const dependency of fiber.dependsOn ?? []) {
          if (fiberIds.has(dependency)) {
            links.push({ source: dependency, target: fiber.id, kind: 'data-flow' });
          }
        }
        // Directory containment, derived from the slug shape: a fiber at
        // `parent/child` lives inside `parent/`, whose own fiber file is
        // `parent/parent.md` (id `parent`). Emitting these as `contains`
        // edges (source=parent, target=child) is what lets vellum's
        // IndexView, FloatingIsland, and NarrativeView treat the fiber
        // tree as a tree — without them, every nested fiber registers as
        // a top-level root and IndexView reads as a flat 2700-line
        // dump. Only emit when the parent fiber actually exists in the
        // city, so a nested-without-parent slug still surfaces at the
        // root rather than dangling.
        const lastSlash = fiber.id.lastIndexOf('/');
        if (lastSlash > 0) {
          const parentId = fiber.id.slice(0, lastSlash);
          if (fiberIds.has(parentId)) {
            links.push({ source: parentId, target: fiber.id, kind: 'contains' });
          }
        }
      }

      const rootSlug = resolveRootSlug(city.name, fiberIds, allFibers);

      // Augment with cross-city navigation + city-as-parent. See the
      // method's doc-comment for the rationale and shape.
      //
      // Special-case: when serving the loom city itself (the same city
      // /global-graph delegates to), skip the synthetic `__loom__`
      // parent — there's no level above loom to climb to, and adding
      // a parent that points back to itself would loop. The other
      // augmentation (cross-city sibling gateways for cities not
      // already represented in the loom tree, root-fiber-as-parent
      // for top-level intra-loom fibers) still applies.
      const isLoomCity = city.name === 'loom';
      const allCities = this.cityLookup.getCities();
      const LOOM_ID = '__loom__';
      const now = new Date().toISOString();
      if (!isLoomCity) {
        nodes.push({
          id: LOOM_ID,
          slug: LOOM_ID,
          label: 'loom',
          status: 'open',
          tags: [],
          kind: '__loom__',
          createdAt: now,
          tempered: false,
          hasStructuredData: false,
          decisionCount: 0,
          findingCount: 0,
        });
      }

      // Cross-city sibling gateways. Each non-self pinned city with a
      // live `.felt/` directory on disk becomes a `__city__:cityId`
      // node parented by loom; clicking it remounts vellum on that
      // city via portolan's `onOpenSyntheticNode` interception.
      //
      // Three filters layered:
      //   1. `isPinned` — exclude ad-hoc cities portolan has seen but
      //      that aren't part of the user's curated kanban / map.
      //   2. `.felt/` exists at the city path (local cities only) —
      //      exclude obsolete cities that have been migrated into
      //      fibers under another loom city, leaving the original path
      //      empty. Without this, the loom retains stale gateways
      //      that 404 on click. Remote cities skip the disk check
      //      since their path is on another host; we trust pinning
      //      for those.
      //   3. Name does NOT match a top-level fiber in this city —
      //      dedup. Symlinks make `~/Documents/projects/portolan/`
      //      (the pinned portolan city) and `~/loom/.felt/portolan/`
      //      (the loom's `portolan/` sub-folder) the same content. If
      //      the current city already exposes "portolan" as a
      //      top-level fiber, emitting `__city__:portolan` as a
      //      cross-city sibling double-counts. The user picks
      //      navigation flavour by clicking the loom-fiber entry
      //      (loom-scope) vs reaching the city via map / kanban
      //      (city-scope).
      // Match on fiber id (slug-shape, the directory basename) since
      // that's what aligns with `otherCity.name` (also the project's
      // directory basename). Comparing against `fiber.name` (the
      // human-readable frontmatter label) would miss nearly everything.
      const topLevelSlugs = new Set(
        allFibers
          .filter((f) => !f.id.includes('/'))
          .map((f) => f.id),
      );
      for (const otherCity of allCities) {
        if (otherCity.id === city.id) continue;
        if (!this.cityLookup.isPinned(otherCity.id)) continue;
        if (otherCity.originId === 'local' && !existsSync(join(otherCity.path, '.felt'))) continue;
        if (topLevelSlugs.has(otherCity.name)) continue;
        const otherSlug = `__city__:${otherCity.id}`;
        nodes.push({
          id: otherSlug,
          slug: otherSlug,
          label: otherCity.name,
          status: 'open',
          tags: [],
          kind: '__city__',
          createdAt: now,
          tempered: false,
          hasStructuredData: false,
          decisionCount: 0,
          findingCount: 0,
        });
        // Parent the gateway under loom for non-loom cities so the
        // user navigates "up to loom" and finds them as siblings of
        // the local root. For the loom city itself there's no loom
        // parent; the gateway sits as a parentless top-level entry,
        // which IndexView and FloatingIsland surface alongside the
        // loom's own top-level fibers.
        if (!isLoomCity) {
          links.push({ source: LOOM_ID, target: otherSlug, kind: 'contains' });
        }
      }

      // Anchor the root fiber under loom (non-loom cities only) and
      // absorb the city's other top-level fibers as its children.
      if (rootSlug && fiberIds.has(rootSlug)) {
        if (!isLoomCity) {
          links.push({ source: LOOM_ID, target: rootSlug, kind: 'contains' });
        }
        for (const fiber of allFibers) {
          // Top-level intra-city fiber, not the root itself, not nested
          // (slug has no `/`). Existing nested fibers (`a/b`) already
          // have correct contains-links from the per-fiber pass above.
          if (fiber.id === rootSlug) continue;
          if (fiber.id.includes('/')) continue;
          links.push({ source: rootSlug, target: fiber.id, kind: 'contains' });
        }
      }

      this.sendJsonSuccess(res, { nodes, links, rootSlug });
    } catch (error: any) {
      console.error('Failed to build fiber graph:', error);
      this.sendJsonError(res, 500, 'Failed to build fiber graph: ' + error.message);
    }
  }

  /**
   * /city-root-slug?cityId=X — just the rootSlug, without the rest of the graph.
   *
   * Vellum modal cold-open used to fetch /fiber-graph twice on open: once in
   * `openVellumWorkspaceModal` (just to read rootSlug) and again inside
   * WorkspaceMount. This endpoint lets the modal land on the right fiber
   * without paying for a 200KB+ graph payload before the WorkspaceMount fetch
   * does it for real. See vellum-dogfood/vellum-modal-double-graph-fetch.
   */
  async handleCityRootSlug(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      this.sendJsonError(res, 400, 'Missing cityId parameter');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return;
    }

    const sshHost = city.originId !== 'local' ? this.getSshHost(city) : undefined;

    try {
      const allFibers = await this.getAllCityFibers(city.path, sshHost);
      const fiberIds = new Set(allFibers.map((fiber) => fiber.id));
      const rootSlug = resolveRootSlug(city.name, fiberIds, allFibers);
      this.sendJsonSuccess(res, { rootSlug });
    } catch (error: any) {
      console.error('Failed to resolve city root slug:', error);
      this.sendJsonError(res, 500, 'Failed to resolve city root slug: ' + error.message);
    }
  }

  /**
   * /fiber/:slug?cityId=X — vellum-shaped FiberContent.
   *
   * Finds the fiber by id within the given city, parses frontmatter as YAML,
   * and transforms the body to mdast via remark + a wikilink plugin (mirror of
   * mystra's markdownToMystAST). Returns null (404) when the fiber is absent.
   *
   * Hybrid HTTP content channel per [[vellum-portolan-adapter-data-gap]]:
   * content is served on demand; WS stays the liveness channel.
   */
  async handleFiberContent(url: URL, slug: string, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      this.sendJsonError(res, 400, 'Missing cityId parameter');
      return;
    }
    if (!slug) {
      this.sendJsonError(res, 400, 'Missing fiber slug');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return;
    }

    const sshHost = city.originId !== 'local' ? this.getSshHost(city) : undefined;

    try {
      const fiber = sshHost
        ? await this.readRemoteFiberJson(city.path, slug, sshHost)
        : await this.readLocalFiberJson(city.path, slug);
      if (!fiber) {
        this.sendJsonError(res, 404, `Fiber "${slug}" not found in city`);
        return;
      }

      const body = typeof fiber.body === 'string' ? fiber.body : '';
      const frontmatter = frontmatterFromFeltJson(fiber);
      const mdast = body.trim() ? markdownToMdast(body) : undefined;
      const dependsOn = dependencyIdsFromValue(fiber.depends_on ?? fiber['depends-on']);

      this.sendJsonSuccess(res, {
        slug,
        kind: typeof frontmatter['kind'] === 'string' ? frontmatter['kind'] : undefined,
        mdast,
        frontmatter,
        dependencies: dependsOn,
      });
    } catch (error: any) {
      console.error('Failed to render fiber content:', error);
      this.sendJsonError(res, 500, 'Failed to render fiber content: ' + error.message);
    }
  }

  /**
   * GET /fiber-raw/:slug?cityId=X — full markdown bytes for Vellum's inline
   * editor. Unlike /fiber/:slug this returns frontmatter + body so the editor
   * can round-trip the file without reparsing YAML.
   */
  async handleRawFiber(url: URL, slug: string, res: ServerResponse): Promise<void> {
    const target = await this.resolveRawFiber(url, slug, res);
    if (!target) return;

    try {
      if (target.kind === 'remote') {
        if (!this.remoteRawFiberExecutor) {
          this.sendJsonError(res, 501, 'Remote raw fiber reads require remote agent wiring');
          return;
        }
        const result = await this.remoteRawFiberExecutor({
          originId: target.originId,
          feltHost: target.feltHost,
          path: target.path,
          operation: 'read',
        });
        if (typeof result.body !== 'string') {
          this.sendJsonError(res, 502, 'Remote agent did not return fiber body');
          return;
        }
        this.sendJsonSuccess(res, {
          slug,
          body: result.body,
          sha256: result.sha256 ?? sha256(result.body),
        });
        return;
      }

      const body = await readFile(target.filePath, 'utf8');
      this.sendJsonSuccess(res, {
        slug,
        body,
        sha256: sha256(body),
      });
    } catch (error: any) {
      console.error('Failed to read raw fiber:', error);
      this.sendJsonError(res, 500, 'Failed to read raw fiber: ' + error.message);
    }
  }

  /**
   * PUT /fiber-raw/:slug?cityId=X — replace an existing local fiber file.
   * This is edit-only: the slug must already resolve as a felt fiber.
   */
  async handlePutRawFiber(
    req: IncomingMessage,
    url: URL,
    slug: string,
    res: ServerResponse,
  ): Promise<void> {
    let data: { body?: unknown };
    try {
      data = await readJsonBody<{ body?: unknown }>(req);
    } catch {
      this.sendJsonError(res, 400, 'Invalid JSON body');
      return;
    }
    if (typeof data.body !== 'string') {
      this.sendJsonError(res, 400, 'body (string) is required');
      return;
    }
    if (data.body.length > 2_000_000) {
      this.sendJsonError(res, 413, 'fiber body exceeds 2 MB');
      return;
    }

    const target = await this.resolveRawFiber(url, slug, res);
    if (!target) return;

    try {
      if (target.kind === 'remote') {
        if (!this.remoteRawFiberExecutor) {
          this.sendJsonError(res, 501, 'Remote raw fiber writes require remote agent wiring');
          return;
        }
        const result = await this.remoteRawFiberExecutor({
          originId: target.originId,
          feltHost: target.feltHost,
          path: target.path,
          operation: 'write',
          body: data.body,
        });
        this.sendJsonSuccess(res, {
          ok: true,
          slug,
          sha256: result.sha256 ?? sha256(data.body),
        });
        return;
      }

      await writeAtomic(target.filePath, data.body);
      this.invalidateFiberListCache(target.city.path);
      this.sendJsonSuccess(res, {
        ok: true,
        slug,
        sha256: sha256(data.body),
      });
    } catch (error: any) {
      console.error('Failed to write raw fiber:', error);
      this.sendJsonError(res, 500, 'Failed to write raw fiber: ' + error.message);
    }
  }

  /**
   * GET /fiber-history/<slug>?cityId=X
   *
   * Returns the full event chain (editorial + mechanical) for a fiber as
   * `{ events: HistoryEvent[] }`. Shells out to
   * `felt history <slug> --mechanical --json` so both event classes arrive
   * in one call. The HistoryCard renders editorial events prominently and
   * hides mechanical events behind a client-side toggle (Stage 4 of the
   * history-panel constitution).
   *
   * Mapping:
   * - Editorial events carry `kind: 'editorial'`, `summary` (raw markdown),
   *   and `summaryAst` (pre-parsed mdast for MyST → React rendering).
   * - Mechanical events carry `kind` (the raw event_type), plus `sizeChars`,
   *   `sizeLines`, and `fieldsChanged` (for `edit` events) from the payload.
   *
   * Returns `{ events, status, reason? }` where:
   * - `status: 'ok'` — events may be empty if the fiber has no history; that's
   *   a legitimate state, not a failure.
   * - `status: 'unavailable'` with `reason: 'busy'` — felt index is locked
   *   (typically by a concurrent writer; common during shuttle activity). The
   *   client should retry. We retry transparently up to 3x with backoff
   *   before surfacing this; if you see it client-side, the index has been
   *   busy for ~1s already.
   * - `status: 'unavailable'` with `reason: 'error'` — felt is missing,
   *   crashed, or returned unparseable output.
   *
   * Never 500. The catch path always responds 200 so client UX can stay
   * inside the page; clients distinguish empty-but-ok from unavailable via
   * the status field.
   */
  async handleFiberHistory(url: URL, slug: string, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      this.sendJsonError(res, 400, 'Missing cityId parameter');
      return;
    }
    // Same slug validation as readFiberFile — guard against path traversal
    // before handing the value to the shell.
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_\-./]*$/.test(slug) || slug.includes('..')) {
      this.sendJsonError(res, 400, 'Invalid slug');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return;
    }

    const sshHost = city.originId !== 'local' ? this.getSshHost(city) : undefined;

    // Retry on felt-index-busy. felt prints `warning: index busy` to stderr
    // when a writer holds the lock (common during shuttle worker activity);
    // the read either errors with non-zero exit or succeeds with stale-ish
    // output. We retry up to 3x with 100/300/700ms backoff before giving
    // up; total worst-case latency ~1.1s, which is well within the user's
    // page-load budget.
    const BACKOFFS_MS = [100, 300, 700];
    let lastError: any = null;
    let lastStderr = '';

    for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, BACKOFFS_MS[attempt - 1]));
      }
      try {
        let raw: string;
        let stderr: string;
        if (!sshHost) {
          // Local: execFile with cwd — cleaner than a shell command string and
          // avoids shell-quoting the slug argument (execFile passes args
          // directly to the OS, no shell expansion).
          const result = await execFileAsync(
            'felt',
            ['history', slug, '--mechanical', '-j'],
            { cwd: city.path, maxBuffer: 2 * 1024 * 1024, timeout: 15_000 },
          );
          raw = result.stdout.trim();
          stderr = result.stderr?.toString() ?? '';
        } else if (this.remoteFiberHistoryExecutor && city.originId) {
          const result = await this.remoteFiberHistoryExecutor({
            originId: city.originId,
            feltHost: city.path,
            slug,
          });
          raw = JSON.stringify(result.events ?? []);
          stderr = '';
        } else {
          // Remote: SSH with a shell command string. shellEscape guards
          // cityPath and slug against path traversal/injection. We capture
          // stderr separately (no `2>/dev/null`) so we can detect busy.
          const command = `cd ${shellEscape(city.path)} && felt history ${shellEscape(slug)} --mechanical -j`;
          const result = await execFileAsync(
            'ssh',
            [sshHost, command],
            { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
          );
          raw = result.stdout.trim();
          stderr = result.stderr?.toString() ?? '';
        }

        // Even if stdout returned, felt may have warned about index busy and
        // emitted a stale or partial chain. Treat that as a retry signal —
        // we want a clean read, not a best-effort one — *unless* this was
        // the last attempt.
        if (/index busy/i.test(stderr) && attempt < BACKOFFS_MS.length) {
          lastStderr = stderr;
          continue;
        }

        // felt history --mechanical --json returns an array of event
        // objects (see felt/cmd/history.go). Map editorial and mechanical
        // to vellum's HistoryEvent shape.
        const rawEvents = JSON.parse(raw || '[]') as Array<Record<string, unknown>>;
        const events = rawEvents
          .filter(
            (ev) =>
              typeof ev['occurred_at'] === 'string' &&
              typeof ev['actor'] === 'string' &&
              typeof ev['event_type'] === 'string',
          )
          .map((ev) => {
            const eventType = ev['event_type'] as string;
            const payload = (ev['payload'] ?? {}) as Record<string, unknown>;

            if (eventType === 'editorial') {
              // felt renamed the editorial body key from `summary` → `text`
              // (see felt/cmd/history.go). New events ship under
              // `payload.text`; older ones still use `payload.summary`. Fall
              // back through both so post-rename events render.
              const summary =
                typeof payload['text'] === 'string' ? payload['text']
                : typeof payload['summary'] === 'string' ? payload['summary']
                : '';
              return {
                kind: 'editorial' as const,
                occurredAt: ev['occurred_at'] as string,
                actor: ev['actor'] as string,
                summary,
                summaryAst: markdownToMdast(summary),
              };
            }

            // Mechanical event — include size metadata and changed-fields
            // list so the HistoryCard can render a compact badge.
            const entry: Record<string, unknown> = {
              kind: eventType,
              occurredAt: ev['occurred_at'] as string,
              actor: ev['actor'] as string,
            };
            if (typeof payload['size_chars'] === 'number') entry['sizeChars'] = payload['size_chars'];
            if (typeof payload['size_lines'] === 'number') entry['sizeLines'] = payload['size_lines'];
            if (Array.isArray(payload['fields_changed'])) entry['fieldsChanged'] = payload['fields_changed'];
            return entry;
          });

        this.sendJsonSuccess(res, { events, status: 'ok' });
        return;
      } catch (error: any) {
        lastError = error;
        const stderr = error.stderr?.toString() ?? '';
        const busySignal = `${stderr}\n${error.message ?? ''}`;
        lastStderr = stderr;
        // Retry on felt-busy; bail immediately on other errors (felt missing,
        // timeout, etc) — those won't get better with another shot.
        if (/index busy/i.test(busySignal) && attempt < BACKOFFS_MS.length) {
          continue;
        }
        break;
      }
    }

    // All retries exhausted (or non-busy error). Distinguish three cases:
    // - busy: client renders "index busy, retry shortly" affordance.
    // - not-found: fiber doesn't exist or has never had any events. Treat as
    //   ok-but-empty (felt prints `Error: no felt found matching ...` to
    //   stderr, exits non-zero — but semantically that's "no history" not
    //   "system unavailable").
    // - error: felt missing, crashed, or returned unparseable output.
    const stderrStr = lastStderr.toString();
    const message = lastError?.message ?? 'unknown';
    if (/no felt found matching/i.test(stderrStr) || /no felt found matching/i.test(message)) {
      this.sendJsonSuccess(res, { events: [], status: 'ok' });
      return;
    }
    const reason = /index busy/i.test(`${stderrStr}\n${message}`) ? 'busy' : 'error';
    console.warn(`[fiber-history] ${slug}: unavailable (${reason}) — ${message} stderr=${stderrStr.slice(0, 200)}`);
    this.sendJsonSuccess(res, {
      events: [],
      status: 'unavailable',
      reason,
      message: reason === 'busy' ? 'felt index busy' : message,
    });
  }

  /**
   * /fiber-locate?slug=Y — resolve a bare fiber slug to the city that owns
   * it. Scans local cities only (remote scans would fan out SSH calls).
   * First hit wins; ambiguity is rare because slugs are unique per loom
   * root. Returns 404 when no local city has a fiber at `.felt/<slug>` or
   * `.felt/<slug>.md`.
   *
   * Used by the frontend to resolve `#fiber=Y` URL fragments on cold load.
   * See vellum-dogfood/url-fragment-fiber-nav.
   */
  async handleFiberLocate(url: URL, res: ServerResponse): Promise<void> {
    const slug = url.searchParams.get('slug');
    if (!slug) {
      this.sendJsonError(res, 400, 'Missing slug parameter');
      return;
    }
    const localCities = this.cityLookup.getCities().filter((c) => c.originId === 'local');
    for (const city of localCities) {
      const raw = await this.readFiberFile(city.path, slug);
      if (raw !== null) {
        this.sendJsonSuccess(res, {
          cityId: city.id,
          cityName: city.name,
          cityPath: city.path,
          originId: city.originId,
        });
        return;
      }
    }
    this.sendJsonError(res, 404, `Fiber "${slug}" not found in any local city`);
  }

  /**
   * /api/search?cityId=X&q=Y — vellum-shaped SearchHit[].
   *
   * Vellum's FloatingIsland renders a search input that calls
   * adapter.searchFibers(q) → /api/search?q=… (see vellum/src/api.ts).
   * Without this endpoint the side-strip search silently returns nothing,
   * because adapter.searchFibers used to return an empty array.
   *
   * Scope: scoped to one city's .felt tree (the same slice vellum already
   * navigates and the same one the side-strip's link list is showing).
   * Cross-city search lives in portolan's GlobalSearchPalette.
   *
   * Score model — substring matches across four surfaces with descending
   * weight so name/slug hits beat body hits on tie. q is lowercased and
   * matched verbatim; this is the same naive contains-match the side-strip
   * filter would do client-side, just done over content vellum's adapter
   * never receives (body, outcome).
   */
  async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!cityId) {
      this.sendJsonError(res, 400, 'Missing cityId parameter');
      return;
    }
    if (!q) {
      this.sendJsonSuccess(res, { hits: [] });
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return;
    }

    const sshHost = city.originId !== 'local' ? this.getSshHost(city) : undefined;
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));

    try {
      // Search uses fiber body for snippet generation and body-includes scoring
      // (line ~430, ~454-462), so we need the body-bearing variant.
      const fibers = await this.getAllCityFibers(city.path, sshHost, { withBody: true });
      const needle = q.toLowerCase();

      const hits = fibers
        .map((fiber) => {
          const name = (fiber.name || fiber.id).toLowerCase();
          const id = fiber.id.toLowerCase();
          const outcome = (fiber.outcome ?? '').toLowerCase();
          const body = (fiber.body ?? '').toLowerCase();
          const tags = (fiber.tags ?? []).join(' ').toLowerCase();

          // Highest-leverage surface first; weights chosen so a name hit
          // always outranks a pure-body hit on the same fiber.
          let score = 0;
          if (name.includes(needle)) score += 100;
          if (id.includes(needle)) score += 80;
          if (tags.includes(needle)) score += 40;
          if (outcome.includes(needle)) score += 20;
          if (body.includes(needle)) score += 5;
          // Whole-word slug match (e.g. q="vellum" hits id "vellum-dogfood")
          // is already covered by id.includes; no extra branch needed.

          return { fiber, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ fiber, score }) => {
          // Snippet: first body line containing the needle, trimmed and
          // ellipsised. Falls back to the body's lede for context-free hits
          // (e.g. tag-only matches) so the dropdown row isn't blank.
          let snippet: string | undefined;
          if (fiber.body) {
            const bodyLower = fiber.body.toLowerCase();
            const idx = bodyLower.indexOf(needle);
            if (idx >= 0) {
              const start = Math.max(0, idx - 40);
              const end = Math.min(fiber.body.length, idx + needle.length + 80);
              snippet = (start > 0 ? '…' : '') + fiber.body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < fiber.body.length ? '…' : '');
            } else {
              snippet = fiber.body.split('\n').find((line) => line.trim())?.slice(0, 120);
            }
          }
          return {
            id: fiber.id,
            title: fiber.name || fiber.id,
            status: fiber.status,
            tags: fiber.tags ?? [],
            snippet,
            outcome: fiber.outcome,
            score,
          };
        });

      this.sendJsonSuccess(res, { hits });
    } catch (error: any) {
      console.error('Failed to search fibers:', error);
      this.sendJsonError(res, 500, 'Failed to search fibers: ' + error.message);
    }
  }

  private async readLocalFiberJson(
    cityPath: string,
    slug: string,
  ): Promise<Record<string, unknown> | null> {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_\-./]*$/.test(slug) || slug.includes('..')) {
      return null;
    }
    try {
      const { stdout } = await execFileAsync(
        'felt',
        ['show', slug, '-j'],
        { cwd: cityPath, maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
      );
      const parsed = JSON.parse(stdout);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private async readRemoteFiberJson(
    cityPath: string,
    slug: string,
    sshHost: string,
  ): Promise<Record<string, unknown> | null> {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_\-./]*$/.test(slug) || slug.includes('..')) {
      return null;
    }
    try {
      const command = `cd ${shellEscape(cityPath)} && felt show ${shellEscape(slug)} -j 2>/dev/null || echo ''`;
      const { stdout } = await execFileAsync(
        'ssh',
        [sshHost, command],
        { maxBuffer: 8 * 1024 * 1024, timeout: 30000 },
      );
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private async readFiberFile(
    cityPath: string,
    slug: string,
    sshHost?: string,
  ): Promise<string | null> {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_\-./]*$/.test(slug) || slug.includes('..')) {
      return null;
    }
    // Two on-disk shapes, mirroring FiberReader.walkFibers:
    //   - Directory-based: `.felt/<slug>/<leaf>.md` (leaf = last segment of slug)
    //   - Entry-point root: bare `.felt/<slug>.md` with no containing dir (only
    //     at the top level — the loom symlink consumes the outer directory)
    // Try directory shape first, then fall through to bare root. Unknown
    // slugs return null either way.
    const leaf = slug.split('/').pop();
    const candidates = [`.felt/${slug}/${leaf}.md`, `.felt/${slug}.md`];
    const readLocal = async (rel: string): Promise<string | null> => {
      try { return await readFile(`${cityPath}/${rel}`, 'utf-8'); }
      catch { return null; }
    };
    const readRemote = async (rel: string): Promise<string | null> => {
      try {
        const { stdout } = await execFileAsync(
          'ssh',
          [sshHost!, `cat ${shellEscape(`${cityPath}/${rel}`)} 2>/dev/null`],
          { maxBuffer: 5 * 1024 * 1024, timeout: 15000 },
        );
        return stdout || null;
      } catch { return null; }
    };
    const read = sshHost ? readRemote : readLocal;
    for (const rel of candidates) {
      const raw = await read(rel);
      if (raw !== null) return raw;
    }

    // Bare-slug fallback (local only): persisted layouts and old URL fragments
    // sometimes carry slugs from before a fiber was nested under a namespace
    // (e.g. layout pin "meeting-to-astra-live-research" → real fiber
    // "meetings/meeting-to-astra-live-research"). Scan all fibers and accept a
    // unique leaf match. Ambiguous bare slugs stay 404 — caller can promote
    // the layout to a fully qualified slug.
    if (!sshHost && !slug.includes('/')) {
      try {
        const all = await getAllFibers(cityPath);
        const matches = all.filter((fiber) => {
          if (fiber.id === slug) return false; // already tried as literal
          const idLeaf = fiber.id.split('/').pop();
          return idLeaf === slug;
        });
        if (matches.length === 1) {
          const resolvedId = matches[0].id;
          const resolvedLeaf = resolvedId.split('/').pop();
          for (const rel of [`.felt/${resolvedId}/${resolvedLeaf}.md`, `.felt/${resolvedId}.md`]) {
            const raw = await readLocal(rel);
            if (raw !== null) return raw;
          }
        }
      } catch {
        // getAllFibers failure shouldn't escalate — fall through to null.
      }
    }

    return null;
  }

  /**
   * List every fiber in a city. Two callers' shapes:
   *   - `withBody: false` (default) — graph and root-slug callers just need
   *     metadata. Skipping `--body` shrinks the SSH JSON payload (every
   *     fiber's full markdown is otherwise serialized over the wire) and
   *     lets felt skip body parsing on the remote side. Hot path for
   *     workspace open.
   *   - `withBody: true` — search callers use the body for
   *     snippet generation and inline rendering.
   * Results are TTL-cached per (host, cityPath, withBody) so the
   * back-to-back /fiber-graph + /city-root-slug pattern at workspace open
   * pays the SSH cost once.
   */
  private async getAllCityFibers(
    cityPath: string,
    sshHost?: string,
    opts: { withBody?: boolean } = {},
  ): Promise<Fiber[]> {
    const withBody = opts.withBody ?? false;
    const host = sshHost ?? 'local';
    const cacheKey = `${host}::${cityPath}::${withBody ? 'body' : 'meta'}`;
    const cached = this.fiberListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.fibers;
    }

    let fibers: Fiber[];
    if (!sshHost) {
      // Local FiberReader always parses the body — local FS reads are cheap
      // Honor `withBody` so search's body-snippet/needle scoring path
      // gets bodies while the metadata-only callers don't pay for them.
      fibers = await getAllFibers(cityPath, { withBody });
    } else {
      const bodyFlag = withBody ? ' --body' : '';
      const command = `cd ${shellEscape(cityPath)} && felt ls -s all --json${bodyFlag} 2>/dev/null || echo '[]'`;
      const { stdout } = await execFileAsync(
        'ssh',
        [sshHost, command],
        { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
      );

      const raw = JSON.parse(stdout.trim() || '[]');
      fibers = Array.isArray(raw)
        ? raw
            .map((fiber: unknown) => mapFeltJsonToFiber(fiber))
            .filter((fiber): fiber is Fiber => fiber !== null)
        : [];
    }

    this.fiberListCache.set(cacheKey, {
      fibers,
      expiresAt: Date.now() + HttpApiFibers.FIBER_LIST_TTL_MS,
    });
    return fibers;
  }

  private async resolveRawFiber(
    url: URL,
    slug: string,
    res: ServerResponse,
  ): Promise<
    | { kind: 'local'; city: City; filePath: string }
    | { kind: 'remote'; city: City; originId: string; feltHost: string; path: string }
    | null
  > {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      this.sendJsonError(res, 400, 'Missing cityId parameter');
      return null;
    }
    if (!isSafeFiberSlug(slug)) {
      this.sendJsonError(res, 400, 'Invalid fiber slug');
      return null;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return null;
    }
    if (city.originId !== 'local') {
      const target = this.resolveRemoteRawFiber(city, slug);
      if (!target) {
        this.sendJsonError(res, 404, `Fiber "${slug}" not found in remote snapshot`);
        return null;
      }
      return target;
    }

    const fiber = await this.readLocalFiberJson(city.path, slug);
    if (!fiber) {
      this.sendJsonError(res, 404, `Fiber "${slug}" not found in city`);
      return null;
    }

    const filePath = resolveFiberMarkdownPath(city.path, slug);
    if (!filePath) {
      this.sendJsonError(res, 404, `Fiber "${slug}" file not found in city`);
      return null;
    }
    return { kind: 'local', city, filePath };
  }

  private resolveRemoteRawFiber(
    city: City,
    slug: string,
  ): { kind: 'remote'; city: City; originId: string; feltHost: string; path: string } | null {
    if (!this.remoteSnapshotsProvider) return null;
    const snapshots = this.remoteSnapshotsProvider();
    const snapshot = snapshots.find((snap) =>
      snap.originId === city.originId && normalizeRemoteHost(snap.feltHost) === normalizeRemoteHost(city.path)
    );
    const fiber = snapshot?.fibers.find((f) => f.id === slug);
    if (!snapshot || !fiber) return null;
    return {
      kind: 'remote',
      city,
      originId: snapshot.originId,
      feltHost: snapshot.feltHost,
      path: relativeFeltPathForFiber(fiber),
    };
  }
}

function isSafeFiberSlug(slug: string): boolean {
  if (!slug || isAbsolute(slug)) return false;
  return slug.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function resolveFiberMarkdownPath(cityPath: string, slug: string): string | null {
  const feltRoot = resolve(cityPath, '.felt');
  const parts = slug.split('/');
  const leaf = parts[parts.length - 1] ?? '';
  const candidates = [
    resolve(feltRoot, slug, `${leaf}.md`),
    resolve(feltRoot, `${slug}.md`),
  ];
  return candidates.find((candidate) => isPathInside(feltRoot, candidate) && existsSync(candidate)) ?? null;
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRemoteHost(path: string): string {
  return path.replace(/\/+$/, '');
}

function relativeFeltPathForFiber(fiber: Fiber): string {
  const segments = fiber.id.split('/');
  const leaf = segments[segments.length - 1];
  return fiber.isRoot ? `${leaf}.md` : `${fiber.id}/${leaf}.md`;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return JSON.parse(body) as T;
}

/**
 * Pick the fiber a vellum workspace should land on for a city. Convention
 * from CLAUDE.md: each project has a root fiber at `.felt/{project}/{project}.md`
 * — `readAllFibers` keys that by the directory name, so the id equals the
 * cityId. Falls through to the nested path (for non-conforming projects) and
 * then to any fiber. Returns null only when the city has no fibers at all.
 */
function resolveRootSlug(
  citySlug: string,
  fiberIds: Set<string>,
  allFibers: Fiber[],
): string | null {
  // City slug is the project's basename (e.g. "pure_eb"), not the hashed cityId.
  // Match the loom root-fiber convention: prefer a top-level fiber whose id
  // equals the slug ("pure_eb"), then the nested form ("pure_eb/pure_eb"),
  // then any fiber tagged `root`, then the first fiber as a last resort.
  // Without using the slug, both checks always fail because cityId is a hash —
  // see vellum-dogfood/vellum-modal-loads-wrong-root.
  if (fiberIds.has(citySlug)) return citySlug;
  const nested = `${citySlug}/${citySlug}`;
  if (fiberIds.has(nested)) return nested;
  const tagged = allFibers.find((fiber) => fiber.tags?.includes('root'));
  if (tagged) return tagged.id;
  return allFibers[0]?.id ?? null;
}

function frontmatterFromFeltJson(fiber: Record<string, unknown>): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = { ...fiber };
  delete frontmatter.body;
  delete frontmatter.id;
  delete frontmatter.modified_at;

  if (typeof frontmatter.created_at === 'string' && frontmatter.created_at.startsWith('0001-')) {
    delete frontmatter.created_at;
  }

  return frontmatter;
}

function dependencyIdsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((dep) => (typeof dep === 'string' ? dep : typeof dep === 'object' && dep !== null ? (dep as Record<string, unknown>).id : undefined))
    .filter((dep): dep is string => typeof dep === 'string' && dep.length > 0);
}
