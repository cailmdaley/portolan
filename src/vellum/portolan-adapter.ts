/**
 * PortolanAdapter — lets vellum read files, fibers, and annotations from the
 * running portolan server.
 *
 * This is the hybrid HTTP content channel from [[vellum-portolan-adapter-data-gap]]:
 *   - getFile wraps /file-content and /project-file
 *   - getAnnotations / createAnnotation etc. wrap /annotations (file-keyed today;
 *     fiber-slug keying TODO on server side)
 *   - getFiberContent hits /fiber/:slug (remark + wikilink transform on demand)
 *   - getAstraGraph hits /astra/graph?cityId=X
 *   - searchFibers wraps /api/search?cityId=…&q=… (server-side substring
 *     match across name/slug/tags/outcome/body, scored)
 *   - getDeltaSince, getRawFiber return empty/null until the server grows
 *     matching endpoints.
 *
 * The adapter deliberately returns well-typed empty sentinels where portolan
 * can't yet serve something so vellum components don't need to distinguish
 * "not implemented" from "no content".
 */

import {
  type Adapter,
  type AstraBundleResult,
  type CreateAnnotationInput,
  type FrontmatterPatch,
  type GetAnnotationsOptions,
  type GetAstraBundleOptions,
  type GetFileOptions,
  type ReadOnlyAdapter,
  type ReadOnlyAdapterError,
  type SaveFileOptions,
} from 'vellum/adapter';
import type {
  Annotation,
  AstraGraph,
  FiberContent,
  FileContent,
  HistoryEvent,
  HistoryResponse,
  LogResponse,
  RawFiber,
  SearchHit,
} from 'vellum';
import type { Bundle } from 'lightcone-ui-core';

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`;

function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('%2F');
}

function isAstraPath(path: string): boolean {
  return /(?:^|\/)astra\.ya?ml$/i.test(path) || /\.astra\.ya?ml$/i.test(path);
}

function classifyFile(path: string): FileContent['kind'] {
  const ext = (path.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html') return 'html';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  // astra.yaml is rendered as the lightcone-ui paper view in an iframe;
  // classify as 'html' so vellum embeds the URL we hand back via getFile,
  // which points at portolan's /astra-paper-view server endpoint instead
  // of the raw YAML. See server/src/HttpApiAstraView.ts.
  if (isAstraPath(path)) return 'html';
  return 'text';
}

function buildAstraViewUrl(path: string, originId: string, cacheBust?: boolean): string {
  const origin = originId || 'local';
  const absPath = path.startsWith('/') ? path : `/${path}`;
  const encodedPath = absPath
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : seg))
    .join('/');
  let url = `${API_BASE}/astra-paper-view/${encodeURIComponent(origin)}${encodedPath}`;
  if (cacheBust) url += `?_t=${Date.now()}`;
  return url;
}

/**
 * Fetch the JSON bundle for an astra.yaml from portolan's `/astra-bundle`
 * endpoint. Returns the rewritten Bundle (artifact paths point at
 * `/project-file/...`) plus inlined CSV previews, or `null` if the server
 * couldn't build it (404, 500, network error). Vellum-native astra
 * renderers consume this so they can run their own React rendering over
 * the same data the iframe paper view sees — see
 * `vellum-reader/vellum-native-astra-renderer`.
 *
 * Typed loosely (`unknown` bundle/csvs) at this seam so the adapter file
 * doesn't pull lightcone-ui-core's `Bundle` into portolan; consumers
 * import that type directly and cast at the call site, just as the
 * iframe path treats `window.__BUNDLE__` as opaque JSON.
 */
export async function fetchAstraBundle(
  path: string,
  originId: string = 'local',
  options: { universe?: string; cacheBust?: boolean } = {},
): Promise<{ bundle: unknown; csvs: Record<string, string>; mtime?: string | null } | null> {
  const absPath = path.startsWith('/') ? path : `/${path}`;
  const encodedPath = absPath
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : seg))
    .join('/');
  const params = new URLSearchParams();
  if (options.universe) params.set('universe', options.universe);
  if (options.cacheBust) params.set('_t', String(Date.now()));
  const qs = params.toString();
  const url = `${API_BASE}/astra-bundle/${encodeURIComponent(originId)}${encodedPath}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json()) as {
    bundle: unknown;
    csvs: Record<string, string>;
    mtime?: string | null;
  };
}

/**
 * Cheap mtime probe for an astra.yaml. Hits portolan's `/astra-mtime` route
 * which short-circuits the buildBundle pipeline — local: a single fs.stat;
 * remote: a single SSH stat. Returns null when the server can't stat the
 * file (404, network error, remote disconnected). Used by vellum's
 * focus-staleness check to decide whether the panel needs to re-fetch
 * the bundle. See `vellum-reader/vellum-native-astra-renderer`.
 */
export async function fetchAstraMtime(
  path: string,
  originId: string = 'local',
): Promise<string | null> {
  const absPath = path.startsWith('/') ? path : `/${path}`;
  const encodedPath = absPath
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : seg))
    .join('/');
  const url = `${API_BASE}/astra-mtime/${encodeURIComponent(originId)}${encodedPath}`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && typeof data.mtime === 'string' ? data.mtime : null;
}

function buildRawFileUrl(path: string, originId: string, cacheBust?: boolean): string {
  // Use /project-file/{originId}{absPath}. It streams pdf/image/html with
  // the right Content-Type and injects a bridge script into html. The
  // /file-content?raw=true path only handles BINARY_EXTENSIONS on the server
  // and returns JSON for html, which iframe embedding cannot consume.
  const origin = originId || 'local';
  const absPath = path.startsWith('/') ? path : `/${path}`;
  const encodedPath = absPath
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : seg))
    .join('/');
  let url = `${API_BASE}/project-file/${encodeURIComponent(origin)}${encodedPath}`;
  if (cacheBust) url += `?_t=${Date.now()}`;
  return url;
}

/**
 * Project a server-side annotation row onto vellum's Annotation shape. The
 * server stores `originalText` / `filePath` etc. while vellum consumers also
 * read `selectedText` and fiber-slug `slug`. Keeping this as a top-level
 * helper lets get/create/update paths all round-trip through the same shape.
 */
function projectAnnotationRow(r: Record<string, unknown>, fallbackSlug: string): Annotation {
  const selected =
    (r.originalText as string | undefined) ?? (r.selectedText as string | undefined) ?? '';
  return {
    id: String(r.id ?? ''),
    slug: (r.filePath as string | undefined) ?? fallbackSlug,
    kind: r.isImageAnnotation ? 'image' : 'text',
    selectedText: selected,
    contextBefore: (r.contextBefore as string | undefined) ?? '',
    contextAfter: (r.contextAfter as string | undefined) ?? '',
    comment: String(r.comment ?? ''),
    createdAt: Number(r.createdAt ?? 0),
    filePath: r.filePath as string | undefined,
    originId: r.originId as string | undefined,
    from: r.from as number | undefined,
    to: r.to as number | undefined,
    line: r.line as number | undefined,
    endLine: r.endLine as number | undefined,
    originalText: r.originalText as string | undefined,
    x: r.x as number | undefined,
    y: r.y as number | undefined,
  };
}

/**
 * Server-side synthetic graph node shape from /global-graph.
 * Mirrors the server's GraphNodeWorld but typed locally so the adapter
 * can map it to vellum's GraphNode without importing server types.
 */
interface GraphNodeWorld {
  id: string;
  slug: string;
  label: string;
  status: string;
  tags: string[];
  kind: string;
  createdAt: string;
  depth: number;
}

interface GraphLinkWorld {
  source: string;
  target: string;
  kind: 'contains' | 'data-flow' | 'cites';
}

export interface PortolanAdapterOptions {
  /** Opaque vellum collection id. Portolan translates it to the server's
   *  `cityId` query param at the HTTP boundary. Optional because many calls
   *  are collection-agnostic. */
  collectionId?: string;
  /** Default origin for file fetches when caller omits it. */
  defaultOriginId?: string;
}

export function createPortolanAdapter(opts: PortolanAdapterOptions = {}): Adapter {
  const defaultOriginId = opts.defaultOriginId ?? 'local';
  const collectionId = opts.collectionId;

  return {
    async getFile(path: string, options: GetFileOptions = {}): Promise<FileContent | null> {
      const originId = options.originId ?? defaultOriginId;
      const kind = classifyFile(path);

      // Binary kinds: return url, no content body. astra.yaml rides the
      // 'html' kind but routes through the dedicated paper-view endpoint
      // rather than /project-file (which would stream raw YAML).
      if (kind === 'pdf' || kind === 'image' || kind === 'html') {
        const url = isAstraPath(path)
          ? buildAstraViewUrl(path, originId, options.cacheBust)
          : buildRawFileUrl(path, originId, options.cacheBust);
        return {
          path,
          kind,
          language: '',
          content: '',
          url,
        };
      }

      const bust = options.cacheBust ? `&_t=${Date.now()}` : '';
      const res = await fetch(
        `${API_BASE}/file-content?path=${encodeURIComponent(path)}&originId=${encodeURIComponent(originId)}${bust}`,
      ).catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json();
      return {
        path: data.path ?? path,
        kind,
        language: data.language ?? '',
        content: data.content ?? '',
        mdast: data.mdast,
        frontmatter: data.frontmatter,
      };
    },

    async getFiberContent(slug: string): Promise<FiberContent | null> {
      if (!collectionId) {
        // Global vellum mode: resolve the slug via /fiber-locate, then fetch
        // the fiber content from that city's graph.

        // Handle synthetic __city__:cityId slugs — these are city-nodes in
        // the global synthetic graph that have no real fiber file. Resolve
        // to the city's root fiber via /city-root-slug, then fetch that.
        // This makes clicking a city node (either from IndexView or the
        // thumb-index ← parent button) land on the city's root fiber
        // narrative page instead of a blank 404.
        if (slug.startsWith('__city__:')) {
          const cityId = slug.slice('__city__:'.length);
          if (!cityId) return null;
          const rootRes = await fetch(
            `${API_BASE}/city-root-slug?cityId=${encodeURIComponent(cityId)}`,
          ).catch(() => null);
          if (!rootRes || !rootRes.ok) return null;
          const rootData = await rootRes.json() as { rootSlug?: string };
          if (!rootData.rootSlug) return null;
          const url = `${API_BASE}/fiber/${encodeSlug(rootData.rootSlug)}?cityId=${encodeURIComponent(cityId)}`;
          const res = await fetch(url).catch(() => null);
          if (!res || res.status === 404 || !res.ok) return null;
          return res.json() as Promise<FiberContent>;
        }

        // Normal global-mode path: resolve via /fiber-locate.
        const locateRes = await fetch(
          `${API_BASE}/fiber-locate?slug=${encodeURIComponent(slug)}`,
        ).catch(() => null);
        if (!locateRes || !locateRes.ok) return null;
        const locate = await locateRes.json() as { cityId?: string };
        const cityId = locate.cityId;
        if (!cityId) return null;
        const url = `${API_BASE}/fiber/${encodeSlug(slug)}?cityId=${encodeURIComponent(cityId)}`;
        const res = await fetch(url).catch(() => null);
        if (!res || res.status === 404 || !res.ok) return null;
        return res.json() as Promise<FiberContent>;
      }
      const url = `${API_BASE}/fiber/${encodeSlug(slug)}?cityId=${encodeURIComponent(collectionId)}`;
      const res = await fetch(url).catch(() => null);
      if (!res || res.status === 404 || !res.ok) return null;
      return res.json() as Promise<FiberContent>;
    },

    async getAstraGraph(): Promise<AstraGraph> {
      if (!collectionId) {
        // Global vellum mode: fetch the synthetic graph from the server.
        // The response contains one node per pinned city (no per-city
        // root fibers — see HttpApiGlobalSearch.globalGraph for why).
        const res = await fetch(`${API_BASE}/global-graph`).catch(() => null);
        if (!res || !res.ok) return { nodes: [], links: [] };
        const graph = await res.json() as { nodes: GraphNodeWorld[]; links: GraphLinkWorld[] };
        // Map server types to vellum's GraphNode/GraphLink. The fields
        // overlap; we spread with client-side defaults for vellum-specific
        // fields the server doesn't emit (tags default, tempered, etc.).
        return {
          nodes: graph.nodes.map((n) => ({
            id: n.id,
            slug: n.slug,
            label: n.label,
            status: n.status,
            tags: n.tags ?? [],
            kind: n.kind ?? '',
            createdAt: n.createdAt,
          })),
          links: graph.links.map((l) => ({
            source: l.source,
            target: l.target,
            kind: l.kind,
          })),
        };
      }
      const res = await fetch(`${API_BASE}/astra/graph?cityId=${encodeURIComponent(collectionId)}`).catch(
        () => null,
      );
      if (!res || !res.ok) return { nodes: [], links: [] };
      return res.json() as Promise<AstraGraph>;
    },

    async getRawFiber(_slug: string): Promise<RawFiber | null> {
      return null;
    },

    async getAnnotations(slug: string, annOpts: GetAnnotationsOptions = {}): Promise<Annotation[]> {
      // Portolan's annotation store is file-keyed (filePath + originId). In the
      // file-viewer context vellum hands us the file path as `slug`; we forward
      // it as `path=` on the wire. `imageSrc`/`kind` are not portolan concepts
      // today but are preserved in the query string for forward compat.
      // Empty slug short-circuits — the canonical caller used to be vellum's
      // NarrativeView fetching the whole project pool for cross-fiber
      // text-matching, but that produced pollution (short selections like
      // "see also" match everywhere) so NarrativeView now scopes per-slug.
      // Returning [] here keeps any other empty-slug caller from accidentally
      // pulling the entire project pool; admins who genuinely want project
      // scope can hit /annotations?all=true directly.
      if (!slug) return [];
      const params = new URLSearchParams({ path: slug, originId: defaultOriginId });
      if (annOpts.kind) params.set('kind', annOpts.kind);
      if (annOpts.imageSrc) params.set('imageSrc', annOpts.imageSrc);
      const res = await fetch(`${API_BASE}/annotations?${params}`).catch(() => null);
      if (!res || !res.ok) return [];
      const data = await res.json();
      // Server shape is file-anchored (filePath, from/to, line/endLine, etc.);
      // vellum's Annotation is fiber-anchored (slug, paragraphIndex) but now
      // carries the file-anchor fields as optionals. Project the server row
      // onto vellum's shape so code renderers can read char offsets directly.
      const rows = (data.annotations ?? []) as Array<Record<string, unknown>>;
      return rows.map((r) => projectAnnotationRow(r, slug));
    },

    async searchFibers(query: string): Promise<SearchHit[]> {
      const q = query.trim();
      if (!q || !collectionId) return [];
      const url = `${API_BASE}/api/search?cityId=${encodeURIComponent(collectionId)}&q=${encodeURIComponent(q)}`;
      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) return [];
      const data = await res.json();
      return (data.hits ?? []) as SearchHit[];
    },

    async getDeltaSince(since: string): Promise<LogResponse> {
      return { since, count: 0, events: [] };
    },

    async getFiberHistory(slug: string): Promise<HistoryResponse> {
      // Resolve cityId. Global vellum mode (no collectionId) locates the
      // owning city first; scoped mode uses collectionId directly. The
      // portolan endpoint returns { events, status, reason? } — we pass
      // status through so the HistoryCard can distinguish "no events"
      // from "felt index busy" instead of conflating them.
      let resolvedCityId = collectionId;
      if (!resolvedCityId) {
        const locateRes = await fetch(
          `${API_BASE}/fiber-locate?slug=${encodeURIComponent(slug)}`,
        ).catch(() => null);
        if (!locateRes || !locateRes.ok) {
          return { events: [], status: 'unavailable', reason: 'error' };
        }
        const locate = await locateRes.json() as { cityId?: string };
        resolvedCityId = locate.cityId;
        if (!resolvedCityId) return { events: [], status: 'ok' };
      }
      const url = `${API_BASE}/fiber-history/${encodeSlug(slug)}?cityId=${encodeURIComponent(resolvedCityId)}`;
      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) {
        return { events: [], status: 'unavailable', reason: 'error' };
      }
      const data = await res.json() as {
        events?: HistoryEvent[];
        status?: 'ok' | 'unavailable';
        reason?: 'busy' | 'error';
      };
      return {
        events: data.events ?? [],
        status: data.status ?? 'ok',
        reason: data.reason,
      };
    },

    async getAstraBundle(
      path: string,
      bundleOpts: GetAstraBundleOptions = {},
    ): Promise<AstraBundleResult | null> {
      const result = await fetchAstraBundle(path, bundleOpts.originId ?? defaultOriginId, {
        universe: bundleOpts.universe,
        cacheBust: bundleOpts.cacheBust,
      });
      // fetchAstraBundle types the bundle as `unknown` at the package
      // boundary so this file doesn't drag lightcone-ui-core's types into
      // the adapter's general API. Cast at this single call site —
      // /astra-bundle's contract is the rewritten Bundle shape, server-side.
      return result
        ? { bundle: result.bundle as Bundle, csvs: result.csvs, mtime: result.mtime ?? null }
        : null;
    },

    async getAstraBundleMtime(
      path: string,
      bundleOpts: GetAstraBundleOptions = {},
    ): Promise<string | null> {
      return fetchAstraMtime(path, bundleOpts.originId ?? defaultOriginId);
    },

    /**
     * Resolve a server-relative asset path (`/project-file/...`,
     * `/papers/<cache_key>/paper.pdf`) into a fully-qualified URL pointing
     * at portolan's HTTP server (`API_BASE`, e.g. `http://localhost:4004`).
     *
     * The server-rewritten Bundle ships these as relative URLs intentionally
     * — the iframe paper-view shares portolan's origin, so relative paths
     * work there. The vellum-native render runs on the SPA origin (Vite dev
     * at :5173 in development), so without this hook a relative
     * `/project-file/...png` path would hit Vite, get the SPA index.html,
     * and either render as a broken image or — in the PdfReader's case —
     * error with "Invalid PDF structure". See
     * `vellum-reader/vellum-native-astra-renderer`.
     */
    resolveAssetUrl(path: string): string {
      if (!path.startsWith('/')) return path;
      return `${API_BASE}${path}`;
    },

    async getAstraSource(path: string, opts: GetFileOptions = {}): Promise<string | null> {
      const originId = opts.originId ?? defaultOriginId;
      const bust = opts.cacheBust ? `&_t=${Date.now()}` : '';
      const res = await fetch(
        `${API_BASE}/file-content?path=${encodeURIComponent(path)}&originId=${encodeURIComponent(originId)}${bust}`,
      ).catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json().catch(() => null);
      return data && typeof data.content === 'string' ? data.content : null;
    },

    async createAnnotation(input: CreateAnnotationInput): Promise<Annotation | null> {
      // Translate vellum's CreateAnnotationInput (slug-keyed, paragraphIndex) to
      // portolan's file-keyed schema. `slug` is the file path when called from
      // the file viewer. The input now carries optional char-offset fields
      // (from/to/line/endLine, originalText) populated by the CodeMirror
      // annotation UI; pass them through verbatim. `paragraphIndex` has no
      // portolan equivalent and is dropped.
      const body = {
        filePath: input.filePath ?? input.slug,
        originId: input.originId ?? defaultOriginId,
        comment: input.comment,
        originalText: input.originalText ?? input.selectedText,
        contextBefore: input.contextBefore,
        contextAfter: input.contextAfter,
        from: input.from,
        to: input.to,
        line: input.line,
        endLine: input.endLine,
        isImageAnnotation: input.kind === 'image' || undefined,
        x: input.x,
        y: input.y,
      };
      const res = await fetch(`${API_BASE}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json();
      const row = data.annotation as Record<string, unknown> | null | undefined;
      return row ? projectAnnotationRow(row, body.filePath) : null;
    },

    async updateAnnotation(id: string, comment: string): Promise<Annotation | null> {
      const res = await fetch(`${API_BASE}/annotations/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      }).catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json();
      const row = data.annotation as Record<string, unknown> | null | undefined;
      if (!row) return null;
      const slug = (row.filePath as string | undefined) ?? '';
      return projectAnnotationRow(row, slug);
    },

    async deleteAnnotation(id: string): Promise<boolean> {
      const res = await fetch(`${API_BASE}/annotations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => null);
      return !!(res && res.ok);
    },

    async patchFiberFrontmatter(_slug: string, _patch: FrontmatterPatch): Promise<void> {
      throw new Error('patchFiberFrontmatter: portolan server endpoint not implemented');
    },

    async putRawFiber(_slug: string, _body: string): Promise<void> {
      throw new Error('putRawFiber: portolan server endpoint not implemented');
    },

    async saveFile(path: string, content: string, saveOpts: SaveFileOptions = {}): Promise<void> {
      const originId = saveOpts.originId ?? defaultOriginId;
      const res = await fetch(`${API_BASE}/save-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content, originId }),
      }).catch(() => null);
      if (!res || !res.ok) {
        const body = await res?.json().catch(() => ({} as { error?: string })) ?? {};
        throw new Error((body as { error?: string }).error ?? `save failed${res ? ` (${res.status})` : ''}`);
      }
    },
  };
}

/**
 * Narrow read-only view for contexts that cannot mutate (e.g. the static
 * tapestry deploy eventually uses a different adapter altogether, but code
 * paths that only read benefit from the narrower type).
 */
export function createPortolanReadOnlyAdapter(opts: PortolanAdapterOptions = {}): ReadOnlyAdapter {
  const full = createPortolanAdapter(opts);
  const {
    getFile,
    getFiberContent,
    getAstraGraph,
    getRawFiber,
    getAnnotations,
    searchFibers,
    getDeltaSince,
    getFiberHistory,
    getAstraBundle,
    getAstraBundleMtime,
    getAstraSource,
  } = full;
  return {
    getFile,
    getFiberContent,
    getAstraGraph,
    getRawFiber,
    getAnnotations,
    searchFibers,
    getDeltaSince,
    getFiberHistory,
    getAstraBundle,
    getAstraBundleMtime,
    getAstraSource,
  };
}

export type { ReadOnlyAdapterError };

