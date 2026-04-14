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
 *   - searchFibers, getDeltaSince, getRawFiber return empty/null until the
 *     server grows matching endpoints.
 *
 * The adapter deliberately returns well-typed empty sentinels where portolan
 * can't yet serve something so vellum components don't need to distinguish
 * "not implemented" from "no content".
 */

import type {
  Adapter,
  CreateAnnotationInput,
  FrontmatterPatch,
  GetAnnotationsOptions,
  GetFileOptions,
  ReadOnlyAdapter,
  ReadOnlyAdapterError,
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
      const params = new URLSearchParams({ slug });
      if (annOpts.kind) params.set('kind', annOpts.kind);
      if (annOpts.imageSrc) params.set('imageSrc', annOpts.imageSrc);
      const res = await fetch(`${API_BASE}/annotations?${params}`).catch(() => null);
      if (!res || !res.ok) return [];
      const data = await res.json();
      return (data.annotations ?? []) as Annotation[];
    },

    async searchFibers(_query: string): Promise<SearchHit[]> {
      return [];
    },

    async getDeltaSince(since: string): Promise<LogResponse> {
      return { since, count: 0, events: [] };
    },

    async createAnnotation(input: CreateAnnotationInput): Promise<Annotation | null> {
      const res = await fetch(`${API_BASE}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }).catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json();
      return (data.annotation ?? null) as Annotation | null;
    },

    async updateAnnotation(id: string, comment: string): Promise<Annotation | null> {
      const res = await fetch(`${API_BASE}/annotations/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      }).catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json();
      return (data.annotation ?? null) as Annotation | null;
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
