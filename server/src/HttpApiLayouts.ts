/**
 * HttpApiLayouts - Pin persistence endpoints for map-pinned vellum cards.
 *
 * See fiber `tapestry-dissolves`. Routes:
 *   GET    /layouts/:cityId                — list pins for a city
 *   PUT    /layouts/:cityId/pins/:slug     — upsert pin {x, z}
 *   DELETE /layouts/:cityId/pins/:slug     — remove pin
 */

import { IncomingMessage, ServerResponse } from 'http';
import type { LayoutStore, PinExtras, PinKind, PinMeta, PinPosition, PinSource } from './LayoutStore.js';
import { kindFromPath, PIN_KINDS, slugForSource } from './LayoutStore.js';
import { stableCityId } from './CityManager.js';

type JsonBodyParser = <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
type JsonErrorSender = (res: ServerResponse, status: number, error: string) => void;
type JsonSuccessSender = (res: ServerResponse, data: Record<string, unknown>) => void;

interface CityLookup {
  getCityById(cityId: string): { path: string; originId: string } | null;
  /** Optional: returns the normalized `${originId}:${path}` cityKey for a known cityId. */
  getCityKey?(cityId: string): string | null;
  /** Optional: lists every known city — used by the /layouts/_diagnostics endpoint. */
  getCities?(): Array<{ id: string; path: string; originId: string }>;
}

interface Options {
  layoutStore: LayoutStore;
  parseJsonBody: JsonBodyParser;
  sendJsonError: JsonErrorSender;
  sendJsonSuccess: JsonSuccessSender;
  /** Optional: if provided, PUT records `${originId}:${path}` as the layout's cityKey. */
  cityLookup?: CityLookup;
}

const PIN_PATH_RE = /^\/layouts\/([^/]+)\/pins\/([^/]+)$/;
const FILES_PATH_RE = /^\/layouts\/([^/]+)\/files$/;
const LIST_PATH_RE = /^\/layouts\/([^/]+)$/;

interface PinPutBody extends PinPosition {
  kind?: PinKind;
  source?: PinSource;
  width?: number;
  height?: number;
}

interface FilePinBody extends PinPosition {
  source: PinSource;
  kind?: PinKind;
}

export class HttpApiLayouts {
  private readonly layoutStore: LayoutStore;
  private readonly parseJsonBody: JsonBodyParser;
  private readonly sendJsonError: JsonErrorSender;
  private readonly sendJsonSuccess: JsonSuccessSender;
  private readonly cityLookup?: CityLookup;

  constructor(options: Options) {
    this.layoutStore = options.layoutStore;
    this.parseJsonBody = options.parseJsonBody;
    this.sendJsonError = options.sendJsonError;
    this.sendJsonSuccess = options.sendJsonSuccess;
    this.cityLookup = options.cityLookup;
  }

  /** Returns true if the request was handled. */
  async handle(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method ?? 'GET';

    if (url.pathname === '/layouts/_diagnostics' && method === 'GET') {
      this.sendJsonSuccess(res, { layouts: this.diagnose() });
      return true;
    }

    const listMatch = url.pathname.match(LIST_PATH_RE);
    if (listMatch && method === 'GET') {
      const cityId = decodeURIComponent(listMatch[1]);
      this.sendJsonSuccess(res, { cityId, pins: this.layoutStore.getPins(cityId) });
      return true;
    }

    const pinMatch = url.pathname.match(PIN_PATH_RE);
    if (pinMatch) {
      const cityId = decodeURIComponent(pinMatch[1]);
      const slug = decodeURIComponent(pinMatch[2]);

      if (method === 'PUT') {
        const body = await this.parseJsonBody<PinPutBody>(req, res);
        if (body === null) return true;
        if (typeof body.x !== 'number' || typeof body.z !== 'number') {
          this.sendJsonError(res, 400, 'Expected body { x: number, z: number }');
          return true;
        }
        if (body.kind && !PIN_KINDS.includes(body.kind)) {
          this.sendJsonError(res, 400, `Unknown kind: ${body.kind}`);
          return true;
        }
        const extras: PinExtras = {};
        if (body.kind) extras.kind = body.kind;
        if (body.source) extras.source = body.source;
        if (typeof body.width === 'number') extras.width = body.width;
        if (typeof body.height === 'number') extras.height = body.height;
        const pin = this.layoutStore.setPin(
          cityId, slug, { x: body.x, z: body.z }, this.metaFor(cityId), extras,
        );
        if (!pin) {
          this.sendJsonError(res, 400, 'Invalid cityId, slug, coordinates, or source');
          return true;
        }
        this.sendJsonSuccess(res, { pin });
        return true;
      }

      if (method === 'DELETE') {
        const removed = this.layoutStore.removePin(cityId, slug);
        this.sendJsonSuccess(res, { removed });
        return true;
      }
    }

    // POST /layouts/:cityId/files — pin a file (or URL). Server derives a stable
    // slug from the source so re-pinning is idempotent. See [[pin-any-file-type]].
    const filesMatch = url.pathname.match(FILES_PATH_RE);
    if (filesMatch && method === 'POST') {
      const cityId = decodeURIComponent(filesMatch[1]);
      const body = await this.parseJsonBody<FilePinBody>(req, res);
      if (body === null) return true;
      if (typeof body.x !== 'number' || typeof body.z !== 'number') {
        this.sendJsonError(res, 400, 'Expected body { x, z, source }');
        return true;
      }
      if (!body.source || typeof body.source !== 'object') {
        this.sendJsonError(res, 400, 'Expected source { originId, path } or { url }');
        return true;
      }
      const slug = slugForSource(body.source);
      if (!slug) {
        this.sendJsonError(res, 400, 'Invalid source: provide either {originId,path} or {url}, not both');
        return true;
      }
      const kind = body.kind ?? (body.source.path ? kindFromPath(body.source.path) : 'other');
      if (!PIN_KINDS.includes(kind)) {
        this.sendJsonError(res, 400, `Unknown kind: ${kind}`);
        return true;
      }
      const pin = this.layoutStore.setPin(
        cityId, slug, { x: body.x, z: body.z }, this.metaFor(cityId),
        { kind, source: body.source },
      );
      if (!pin) {
        this.sendJsonError(res, 400, 'Invalid cityId, coordinates, or source');
        return true;
      }
      this.sendJsonSuccess(res, { pin });
      return true;
    }

    return false;
  }

  private metaFor(cityId: string): PinMeta {
    const meta: PinMeta = {};
    const cityKey = this.cityLookup?.getCityKey?.(cityId)
      ?? (() => {
        const city = this.cityLookup?.getCityById(cityId);
        return city ? `${city.originId}:${city.path}` : null;
      })();
    if (cityKey) meta.cityKey = cityKey;
    return meta;
  }

  /**
   * Classify every layout file on disk against the live city set.
   *
   * Status:
   *   - `live`    — cityId matches a known city, cityKey (if recorded) hashes to it
   *   - `mismatch`— cityKey is recorded but does NOT hash to cityId (corrupted file)
   *   - `orphan`  — cityKey is recorded and well-formed, but no current city has that id
   *   - `unkeyed` — pre-2026-04 file with no cityKey; cannot diagnose without a write
   */
  private diagnose(): Array<{
    cityId: string;
    cityKey: string | null;
    pinCount: number;
    file: string;
    status: 'live' | 'mismatch' | 'orphan' | 'unkeyed';
    currentCityName?: string;
  }> {
    const cities = this.cityLookup?.getCities?.() ?? [];
    const cityById = new Map(cities.map(c => [c.id, c]));
    return this.layoutStore.scanLayouts().map(({ cityId, cityKey, file }) => {
      const pinCount = this.layoutStore.getPins(cityId).length;
      const liveCity = cityById.get(cityId);
      let status: 'live' | 'mismatch' | 'orphan' | 'unkeyed';
      if (cityKey === null) {
        status = liveCity ? 'live' : 'unkeyed';
      } else if (stableCityId(cityKey) !== cityId) {
        status = 'mismatch';
      } else {
        status = liveCity ? 'live' : 'orphan';
      }
      return {
        cityId,
        cityKey,
        pinCount,
        file,
        status,
        ...(liveCity ? { currentCityName: liveCity.path } : {}),
      };
    });
  }
}
