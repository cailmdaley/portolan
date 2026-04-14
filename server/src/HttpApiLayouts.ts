/**
 * HttpApiLayouts - Pin persistence endpoints for map-pinned vellum cards.
 *
 * See fiber `tapestry-dissolves`. Routes:
 *   GET    /layouts/:cityId                — list pins for a city
 *   PUT    /layouts/:cityId/pins/:slug     — upsert pin {x, z}
 *   DELETE /layouts/:cityId/pins/:slug     — remove pin
 */

import { IncomingMessage, ServerResponse } from 'http';
import type { LayoutStore, PinMeta, PinPosition } from './LayoutStore.js';

type JsonBodyParser = <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
type JsonErrorSender = (res: ServerResponse, status: number, error: string) => void;
type JsonSuccessSender = (res: ServerResponse, data: Record<string, unknown>) => void;

interface CityLookup {
  getCityById(cityId: string): { path: string; originId: string } | null;
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
const LIST_PATH_RE = /^\/layouts\/([^/]+)$/;

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
        const body = await this.parseJsonBody<PinPosition>(req, res);
        if (body === null) return true;
        if (typeof body.x !== 'number' || typeof body.z !== 'number') {
          this.sendJsonError(res, 400, 'Expected body { x: number, z: number }');
          return true;
        }
        const meta: PinMeta = {};
        const city = this.cityLookup?.getCityById(cityId);
        if (city) meta.cityKey = `${city.originId}:${city.path}`;
        const pin = this.layoutStore.setPin(cityId, slug, { x: body.x, z: body.z }, meta);
        if (!pin) {
          this.sendJsonError(res, 400, 'Invalid cityId, slug, or coordinates');
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

    return false;
  }
}
