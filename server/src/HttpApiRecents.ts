/**
 * HttpApiRecents — Stage G of constitution-portolan-navigation-layer.
 *
 * Two endpoints:
 *   GET  /recents?cityId=&kind=&limit=    → top-N rolled-up entries
 *   POST /recents/touch                   → record a single view
 *
 * Path is opaque to this layer — caller (frontend / EventWatcher hook)
 * decides whether the path is a fiber slug or a file path. The store
 * partitions by `kind` so the two namespaces don't collide.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type {
  RecentEntry,
  RecentKind,
  RecentViewerKind,
  RecentsStore,
} from './RecentsStore.js';

interface HttpApiRecentsDeps {
  parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
  sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;
}

interface TouchRequestBody {
  viewerKind?: RecentViewerKind;
  viewerId?: string;
  originId?: string;
  cityId?: string;
  kind?: RecentKind;
  path?: string;
  timestamp?: number;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 100;

export class HttpApiRecents {
  private store: RecentsStore | null = null;
  private deps: HttpApiRecentsDeps;

  constructor(deps: HttpApiRecentsDeps) {
    this.deps = deps;
  }

  setStore(store: RecentsStore): void {
    this.store = store;
  }

  async handleGetRecents(url: URL, res: ServerResponse): Promise<void> {
    if (!this.store) {
      // No store wired (test harness or sqlite-unavailable boot). Return
      // an empty list rather than 500ing — the Recents column degrades
      // gracefully to "no recents yet" instead of an error toast.
      this.deps.sendJsonSuccess(res, { entries: [], enabled: false });
      return;
    }
    const cityId = url.searchParams.get('cityId') || undefined;
    const kindRaw = url.searchParams.get('kind') || undefined;
    const kind: RecentKind | undefined =
      kindRaw === 'fiber' || kindRaw === 'file' ? kindRaw : undefined;
    const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(MAX_LIMIT, limitRaw))
      : DEFAULT_LIMIT;

    const entries: RecentEntry[] = this.store.getRecents({ cityId, kind, limit });
    this.deps.sendJsonSuccess(res, {
      entries,
      enabled: this.store.isEnabled(),
      cityId: cityId ?? null,
      kind: kind ?? null,
      limit,
    });
  }

  async handleTouchRecent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.store) {
      this.deps.sendJsonSuccess(res, { ok: true, enabled: false });
      return;
    }
    const body = await this.deps.parseJsonBody<TouchRequestBody>(req, res);
    if (!body) return; // parseJsonBody already wrote 400

    const {
      viewerKind,
      viewerId,
      originId,
      cityId,
      kind,
      path,
      timestamp,
    } = body;

    if (viewerKind !== 'human' && viewerKind !== 'agent') {
      this.deps.sendJsonError(res, 400, 'viewerKind must be "human" or "agent"');
      return;
    }
    if (kind !== 'fiber' && kind !== 'file') {
      this.deps.sendJsonError(res, 400, 'kind must be "fiber" or "file"');
      return;
    }
    if (!viewerId || !originId || !cityId || !path) {
      this.deps.sendJsonError(
        res,
        400,
        'viewerId, originId, cityId, path are all required',
      );
      return;
    }

    this.store.recordView({
      viewerKind,
      viewerId,
      originId,
      cityId,
      kind,
      path,
      timestamp: typeof timestamp === 'number' ? timestamp : undefined,
    });
    this.deps.sendJsonSuccess(res, { ok: true, enabled: this.store.isEnabled() });
  }
}
