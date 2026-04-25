import { execFile } from 'child_process';
import type { ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import { readEvidence, readEvidenceBatch, getSpecName, computeStaleness, type Evidence } from './EvidenceReader.js';
import { getAllFibers, type Fiber } from './FiberReader.js';
import { HttpApiFileContent, HTTP_API_MIME_TYPES } from './HttpApiFileContent.js';
import { markdownToMdast } from './MarkdownToMdast.js';
import { shellEscape } from './ShellPathUtils.js';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

interface CityLookup {
  getCityById(cityId: string): City | null;
  /** All known cities (used by /fiber-locate to scan for a slug). */
  getCities(): City[];
}

interface HttpApiTapestryOptions {
  cityLookup: CityLookup;
  fileContentApi: HttpApiFileContent;
  getSshHost: (city: City) => string;
  sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;
}

export class HttpApiTapestry {
  private readonly cityLookup: CityLookup;
  private readonly fileContentApi: HttpApiFileContent;
  private readonly getSshHost: (city: City) => string;
  private readonly sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  private readonly sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;

  constructor(options: HttpApiTapestryOptions) {
    this.cityLookup = options.cityLookup;
    this.fileContentApi = options.fileContentApi;
    this.getSshHost = options.getSshHost;
    this.sendJsonError = options.sendJsonError;
    this.sendJsonSuccess = options.sendJsonSuccess;
  }

  async handleTapestry(url: URL, res: ServerResponse): Promise<void> {
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
      const ruleFibers = allFibers.filter((fiber) =>
        fiber.tags?.some((tag) => tag.startsWith('tapestry:'))
      );
      const fiberIds = new Set(ruleFibers.map((fiber) => fiber.id));

      const fiberSpecMap = new Map<string, string>();
      for (const fiber of ruleFibers) {
        const specName = getSpecName(fiber.tags || []);
        if (specName) {
          fiberSpecMap.set(fiber.id, specName);
        }
      }

      const uniqueSpecNames = Array.from(new Set(fiberSpecMap.values()));
      let evidenceMap: Map<string, Evidence | null>;
      if (sshHost && uniqueSpecNames.length > 0) {
        evidenceMap = await readEvidenceBatch(city.path, uniqueSpecNames, sshHost);
      } else {
        evidenceMap = new Map<string, Evidence | null>();
        await Promise.all(
          uniqueSpecNames.map(async (specName) => {
            const evidence = await readEvidence(city.path, specName);
            evidenceMap.set(specName, evidence);
          })
        );
      }

      const depsMap = new Map<string, string[]>();
      for (const fiber of ruleFibers) {
        depsMap.set(fiber.id, (fiber.dependsOn || []).filter((dep) => fiberIds.has(dep)));
      }

      const nodes = ruleFibers.map((fiber) => {
        const specName = fiberSpecMap.get(fiber.id);
        const evidence = specName ? evidenceMap.get(specName) : null;
        const deps = depsMap.get(fiber.id) || [];
        const staleness = computeStaleness(fiber.id, depsMap, evidenceMap, fiberSpecMap);

        return {
          id: fiber.id,
          name: fiber.name,
          kind: fiber.kind,
          status: fiber.status,
          body: fiber.body,
          outcome: fiber.outcome || null,
          tags: fiber.tags || [],
          createdAt: fiber.createdAt || null,
          closedAt: fiber.closedAt || null,
          dependsOn: deps,
          specName: specName || null,
          staleness,
          evidence: evidence ? {
            metrics: evidence.metrics,
            artifacts: evidence.artifacts,
            mtime: evidence.mtime,
            generated: evidence.generated ?? null,
          } : null,
        };
      });

      const links: Array<{ source: string; target: string }> = [];
      for (const fiber of ruleFibers) {
        for (const dependency of fiber.dependsOn || []) {
          if (fiberIds.has(dependency)) {
            links.push({ source: dependency, target: fiber.id });
          }
        }
      }

      const downstreamMap: Record<string, Array<{ id: string; name: string; status: string; kind: string }>> = {};
      for (const fiber of ruleFibers) {
        for (const dependency of fiber.dependsOn || []) {
          if (fiberIds.has(dependency)) {
            if (!downstreamMap[dependency]) {
              downstreamMap[dependency] = [];
            }
            downstreamMap[dependency].push({
              id: fiber.id,
              name: fiber.name,
              status: fiber.status,
              kind: fiber.kind,
            });
          }
        }
      }

      const config = await this.readCityConfig(city.path, sshHost);
      const fibers = allFibers.map((fiber) => ({
        id: fiber.id,
        name: fiber.name,
        status: fiber.status,
        kind: fiber.kind,
        tags: fiber.tags,
        body: fiber.body,
        outcome: fiber.outcome || null,
        createdAt: fiber.createdAt || null,
        closedAt: fiber.closedAt || null,
        dependsOn: fiber.dependsOn || [],
      }));

      const decisions = await this.readASTRADecisions(city.path, nodes, sshHost);

      this.sendJsonSuccess(res, {
        nodes,
        links,
        downstream: downstreamMap,
        config,
        fibers,
        decisions,
      });
    } catch (error: any) {
      console.error('Failed to build tapestry:', error);
      this.sendJsonError(res, 500, 'Failed to build tapestry: ' + error.message);
    }
  }

  /**
   * /astra/graph?cityId=X — vellum-shaped AstraGraph (nodes + links).
   *
   * Reshapes the same fiber data /tapestry reads, but emits vellum's
   * GraphNode/GraphLink types (see lightcone/vellum/src/utils/content-types.ts).
   * Unlike /tapestry this returns *all* fibers, not only those tagged
   * `tapestry:`, because vellum's graph view handles filtering itself.
   *
   * First-pass fields: id, slug, label, status, tags, kind, createdAt.
   * Links default to kind 'data-flow' (from dependsOn). ASTRA extras
   * (decisions/findings/inputs/outputs, tempered, nested containment, wikilink
   * cites) are intentionally stubbed — they grow in as mystra-on-fiber lands.
   */
  async handleAstraGraph(url: URL, res: ServerResponse): Promise<void> {
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

      const nodes = allFibers.map((fiber) => ({
        id: fiber.id,
        slug: fiber.id,
        label: fiber.name,
        status: fiber.status,
        tags: fiber.tags ?? [],
        kind: fiber.kind,
        createdAt: fiber.createdAt || undefined,
        tempered: false,
        hasASTRA: false,
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

      this.sendJsonSuccess(res, { nodes, links, rootSlug });
    } catch (error: any) {
      console.error('Failed to build astra graph:', error);
      this.sendJsonError(res, 500, 'Failed to build astra graph: ' + error.message);
    }
  }

  /**
   * /city-root-slug?cityId=X — just the rootSlug, without the rest of the graph.
   *
   * Vellum modal cold-open used to fetch /astra/graph twice on open: once in
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
      const raw = await this.readFiberFile(city.path, slug, sshHost);
      if (raw === null) {
        this.sendJsonError(res, 404, `Fiber "${slug}" not found in city`);
        return;
      }

      const { frontmatter, body } = splitFrontmatter(raw);
      const mdast = body.trim() ? markdownToMdast(body) : undefined;
      const dependsOn: string[] = Array.isArray(frontmatter['depends-on'])
        ? frontmatter['depends-on']
            .map((dep: any) => (typeof dep === 'string' ? dep : dep?.id))
            .filter((dep: unknown): dep is string => typeof dep === 'string')
        : [];

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
      const fibers = await this.getAllCityFibers(city.path, sshHost);
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

  async handleTapestryAsset(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    const rawPath = url.pathname.replace('/tapestry-asset/', '');
    const parts = rawPath.split('/');

    if (!cityId || parts.length < 2) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Missing cityId or invalid asset path');
      return;
    }

    let assetPath: string;
    try {
      assetPath = decodeURIComponent(parts.join('/'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Invalid asset path');
      return;
    }

    await this.serveTapestryAsset(cityId, assetPath, res);
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

  private async getAllCityFibers(cityPath: string, sshHost?: string): Promise<Fiber[]> {
    if (!sshHost) {
      return getAllFibers(cityPath);
    }

    const command = `cd ${shellEscape(cityPath)} && felt ls -s all --json --body 2>/dev/null || echo '[]'`;
    const { stdout } = await execFileAsync(
      'ssh',
      [sshHost, command],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    );

    const raw = JSON.parse(stdout.trim() || '[]');
    return raw.map((fiber: any): Fiber => ({
      id: fiber.id,
      name: fiber.name || fiber.id,
      status: fiber.status || 'open',
      kind: fiber.kind || 'task',
      priority: fiber.priority || 2,
      createdAt: fiber.created_at || '',
      closedAt: fiber.closed_at,
      outcome: fiber.outcome,
      body: fiber.body,
      tags: fiber.tags?.flatMap((tag: string) =>
        tag.includes(',') ? tag.split(',').map((value: string) => value.trim()).filter(Boolean) : [tag]
      ),
      dependsOn: fiber.depends_on?.map((dependency: any) =>
        typeof dependency === 'string' ? dependency : dependency.id
      ),
    }));
  }

  private async readCityConfig(
    cityPath: string,
    sshHost?: string,
  ): Promise<Record<string, string> | null> {
    const candidates = [
      `${cityPath}/config/config.yaml`,
      `${cityPath}/workflow/config/config.yaml`,
    ];

    try {
      let content = '';
      if (sshHost) {
        const tryPaths = candidates.map((candidate) => `cat ${shellEscape(candidate)} 2>/dev/null`).join(' || ');
        const { stdout } = await execFileAsync(
          'ssh',
          [sshHost, `${tryPaths} || echo ''`],
          { maxBuffer: 1024 * 1024, timeout: 10000 }
        );
        content = stdout.trim();
      } else {
        for (const candidate of candidates) {
          try {
            content = await readFile(candidate, 'utf-8');
            break;
          } catch {
            // Try the next candidate path.
          }
        }
      }

      if (!content) {
        return null;
      }

      const { parse } = await import('yaml');
      const data = parse(content);
      if (!data || typeof data !== 'object') {
        return null;
      }

      const flat: Record<string, string> = {};
      const walk = (value: unknown, prefix: string) => {
        if (value === null || value === undefined) {
          return;
        }
        if (Array.isArray(value)) {
          flat[prefix] = JSON.stringify(value);
          return;
        }
        if (typeof value === 'object') {
          for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            walk(nestedValue, prefix ? `${prefix}.${key}` : key);
          }
          return;
        }
        flat[prefix] = String(value);
      };

      walk(data, '');
      return flat;
    } catch {
      return null;
    }
  }

  private async readASTRADecisions(
    cityPath: string,
    nodes: Array<{ id: string; specName: string | null; tags: string[] }>,
    sshHost?: string,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      let content = '';
      const astraPath = `${cityPath}/astra.yaml`;
      if (sshHost) {
        const { stdout } = await execFileAsync(
          'ssh',
          [sshHost, `cat ${shellEscape(astraPath)} 2>/dev/null || echo ''`],
          { maxBuffer: 1024 * 1024, timeout: 10000 },
        );
        content = stdout.trim();
      } else {
        try {
          content = await readFile(astraPath, 'utf-8');
        } catch {
          return [];
        }
      }
      if (!content) return [];

      const { parse } = await import('yaml');
      const data = parse(content);
      if (!data?.decisions || typeof data.decisions !== 'object') return [];

      // Build specName→nodeId and tag→nodeId maps for evidence wiring
      const specToIds = new Map<string, string[]>();
      const tagToIds = new Map<string, string[]>();
      for (const node of nodes) {
        if (node.specName) {
          const ids = specToIds.get(node.specName) || [];
          ids.push(node.id);
          specToIds.set(node.specName, ids);
        }
        for (const tag of node.tags) {
          const ids = tagToIds.get(tag) || [];
          ids.push(node.id);
          tagToIds.set(tag, ids);
        }
      }

      const flattenDecisions = (
        rawDecisions: Record<string, any>,
        analysisId: string,
      ): Array<Record<string, unknown>> => {
        return Object.entries(rawDecisions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, dec]) => {
            const tapestryNodes: string[] = dec.tapestry_nodes || [];
            let evidenceIds: string[] = [];
            for (const specName of tapestryNodes) {
              const matched = specToIds.get(specName) || [];
              for (const nid of matched) {
                if (!evidenceIds.includes(nid)) evidenceIds.push(nid);
              }
            }
            if (evidenceIds.length === 0) {
              for (const nid of tagToIds.get(`evidence:${id}`) || []) {
                if (!evidenceIds.includes(nid)) evidenceIds.push(nid);
              }
            }
            evidenceIds.sort();

            const options = Object.entries(dec.options || {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([optId, opt]: [string, any]) => ({
                id: optId,
                label: opt.label || optId,
                description: opt.description || '',
                excluded: opt.excluded || false,
                excludedReason: opt.excluded_reason || '',
              }));

            return {
              id,
              label: dec.label || id,
              rationale: dec.rationale || '',
              tags: dec.tags || [],
              default: dec.default || '',
              analysisId,
              options,
              evidenceIds,
            };
          });
      };

      const decisions = flattenDecisions(data.decisions, '');
      if (data.analyses && typeof data.analyses === 'object') {
        for (const [analysisId, analysis] of Object.entries(data.analyses as Record<string, any>).sort(([a], [b]) => a.localeCompare(b))) {
          if (analysis.decisions && typeof analysis.decisions === 'object') {
            decisions.push(...flattenDecisions(analysis.decisions, analysisId));
          }
        }
      }
      return decisions;
    } catch {
      return [];
    }
  }

  private async serveTapestryAsset(cityId: string, assetPath: string, res: ServerResponse): Promise<void> {
    if (assetPath.includes('..') || /[`$"\\]/.test(assetPath)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Invalid asset path');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('City not found');
      return;
    }

    const fullPath = `${city.path}/results/tapestry/${assetPath}`;
    const ext = assetPath.split('.').pop()?.toLowerCase();
    const contentType = HTTP_API_MIME_TYPES[ext || ''] || 'application/octet-stream';
    const timeout = ext === 'pdf' ? 60000 : 30000;

    try {
      if (city.originId === 'local') {
        await this.fileContentApi.streamLocalBinaryFile(fullPath, contentType, 'no-cache', res);
      } else {
        const sshHost = this.getSshHost(city);
        await this.fileContentApi.streamRemoteBinaryFile(sshHost, fullPath, contentType, 'no-cache', timeout, res);
      }
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        return;
      }

      const statusCode = typeof (error as { statusCode?: number })?.statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : ((error as { code?: string })?.code === 'ENOENT' ? 404 : 500);

      res.writeHead(statusCode, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      if (statusCode === 404) {
        res.end(`Asset not found: ${assetPath}`);
        return;
      }
      res.end('Failed to read asset');
    }
  }
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

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

function splitFrontmatter(raw: string): { frontmatter: Record<string, any>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  let frontmatter: Record<string, any> = {};
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, any>;
    }
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}
