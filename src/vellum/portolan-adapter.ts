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
  asReadOnlyAdapter,
  type Adapter,
  type CreateAnnotationInput,
  type FrontmatterPatch,
  type GetAnnotationsOptions,
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
  LogResponse,
  RawFiber,
  SearchHit,
} from 'vellum';

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`;

function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('%2F');
}

function classifyFile(path: string): FileContent['kind'] {
  const ext = (path.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html') return 'html';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  return 'text';
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

export interface PortolanAdapterOptions {
  /** City ID for graph-scoped queries. Optional because many calls are city-agnostic. */
  cityId?: string;
  /** Default origin for file fetches when caller omits it. */
  defaultOriginId?: string;
}

export function createPortolanAdapter(opts: PortolanAdapterOptions = {}): Adapter {
  const defaultOriginId = opts.defaultOriginId ?? 'local';

  return {
    async getFile(path: string, options: GetFileOptions = {}): Promise<FileContent | null> {
      const originId = options.originId ?? defaultOriginId;
      const kind = classifyFile(path);

      // Binary kinds: return url, no content body.
      if (kind === 'pdf' || kind === 'image' || kind === 'html') {
        return {
          path,
          kind,
          language: '',
          content: '',
          url: buildRawFileUrl(path, originId, options.cacheBust),
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
      };
    },

    async getFiberContent(slug: string): Promise<FiberContent | null> {
      if (!opts.cityId) return null;
      const url = `${API_BASE}/fiber/${encodeSlug(slug)}?cityId=${encodeURIComponent(opts.cityId)}`;
      const res = await fetch(url).catch(() => null);
      if (!res || res.status === 404 || !res.ok) return null;
      return res.json() as Promise<FiberContent>;
    },

    async getAstraGraph(): Promise<AstraGraph> {
      if (!opts.cityId) return { nodes: [], links: [] };
      const res = await fetch(`${API_BASE}/astra/graph?cityId=${encodeURIComponent(opts.cityId)}`).catch(
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
      // Fiber-narrative views call us with an empty slug — there's no file
      // path to query, so short-circuit before the server logs a 400.
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
      if (!q || !opts.cityId) return [];
      const url = `${API_BASE}/api/search?cityId=${encodeURIComponent(opts.cityId)}&q=${encodeURIComponent(q)}`;
      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) return [];
      const data = await res.json();
      return (data.hits ?? []) as SearchHit[];
    },

    async getDeltaSince(since: string): Promise<LogResponse> {
      return { since, count: 0, events: [] };
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
  } = full;
  return {
    getFile,
    getFiberContent,
    getAstraGraph,
    getRawFiber,
    getAnnotations,
    searchFibers,
    getDeltaSince,
  };
}

export type { ReadOnlyAdapterError };

export interface PortolanStaticAdapterOptions {
  /**
   * Base URL for the static tapestry export (e.g. "./data/pure_eb"). File
   * hrefs are flattened (`/` → `_`) and looked up under `${base}/files/`.
   * Matches what `felt export --format tapestry` writes and what the old
   * hand-rolled TapestryStaticFileModal resolved.
   */
  staticDataBase: string;
}

function flatFileUrl(staticDataBase: string, path: string): string {
  const flat = path.replace(/^\.{0,2}\//, '').replace(/\//g, '_');
  return `${staticDataBase}/files/${flat}`;
}

/**
 * Read-only adapter for the static tapestry deploy. The static export bakes
 * files into `${staticDataBase}/files/` with `/` → `_`; no server round-trip.
 * Fiber- and graph-shaped endpoints are not yet prebaked, so they return
 * empty sentinels.
 *
 * Returned as a full `Adapter` (write methods throw `ReadOnlyAdapterError`)
 * so it drops into any `<AdapterProvider>` without a separate code path.
 */
export function createPortolanStaticAdapter(opts: PortolanStaticAdapterOptions): Adapter {
  const ro: ReadOnlyAdapter = {
    async getFile(path: string): Promise<FileContent | null> {
      const kind = classifyFile(path);
      const url = flatFileUrl(opts.staticDataBase, path);

      if (kind === 'pdf' || kind === 'image' || kind === 'html') {
        // Guard pdf: if the asset is missing the static host may return an
        // HTML 404 page. Let the reader surface "file not found" rather than
        // feeding garbage into pdf.js.
        if (kind === 'pdf') {
          const probe = await fetch(url, { method: 'HEAD' }).catch(() => null);
          const ct = probe?.headers.get('content-type') ?? '';
          if (!probe?.ok || !ct.includes('application/pdf')) return null;
        }
        return { path, kind, language: '', content: '', url };
      }

      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) return null;
      const ct = res.headers.get('content-type') ?? '';
      // SPA catch-all: text/markdown files arrived as an HTML fallback page.
      if (ct.includes('text/html')) return null;
      const text = await res.text();
      return { path, kind, language: '', content: text };
    },

    async getFiberContent(): Promise<FiberContent | null> {
      return null;
    },

    async getAstraGraph(): Promise<AstraGraph> {
      return { nodes: [], links: [] };
    },

    async getRawFiber(): Promise<RawFiber | null> {
      return null;
    },

    async getAnnotations(): Promise<Annotation[]> {
      return [];
    },

    async searchFibers(): Promise<SearchHit[]> {
      return [];
    },

    async getDeltaSince(since: string): Promise<LogResponse> {
      return { since, count: 0, events: [] };
    },
  };

  return asReadOnlyAdapter(ro);
}
