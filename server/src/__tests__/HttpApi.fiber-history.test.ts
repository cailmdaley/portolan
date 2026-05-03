/**
 * HttpApi /fiber-history/:slug endpoint tests.
 *
 * The endpoint shells out to `felt history <slug> --json` to fetch editorial
 * events. Tests cover the validation paths (400/404) and the graceful-empty
 * fallback — when felt is absent or returns nothing, the endpoint returns
 * `{ events: [] }` rather than 500, so the HistoryCard silently drops out
 * rather than surfacing a network error to the reader.
 *
 * The happy-path (felt present + fiber has events) is exercised by the
 * running system; integration here would require the test fiber to live in
 * the loom SQLite DB, which is machine-state-dependent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import {
  httpRequest,
  makeCityLookup,
  stubOriginLookup,
  stubPersistenceLookup,
} from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-fiber-history');

describe('HttpApi — /fiber-history/:slug endpoint', () => {
  const CITY_DIR = join(TEST_DIR, 'test-city');
  const FELT_DIR = join(CITY_DIR, '.felt');
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(FELT_DIR, { recursive: true });
    api = new HttpApi(
      makeCityLookup('test', CITY_DIR) as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns 400 without cityId', async () => {
    const res = await httpRequest(api, 'GET', '/fiber-history/some-slug');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/cityId/i);
  });

  it('returns 404 for unknown city', async () => {
    const res = await httpRequest(api, 'GET', '/fiber-history/some-slug?cityId=nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 400 for path-traversal slug', async () => {
    const res = await httpRequest(
      api,
      'GET',
      '/fiber-history/..%2Fetc%2Fpasswd?cityId=test',
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/invalid slug/i);
  });

  it('returns 400 for slug with double-dot segment', async () => {
    const res = await httpRequest(
      api,
      'GET',
      `/fiber-history/${encodeURIComponent('../escape')}?cityId=test`,
    );
    expect(res.status).toBe(400);
  });

  it('returns empty events when felt is unavailable or fiber has no history', async () => {
    // felt is unlikely to find this slug in a temp test directory; the
    // endpoint's catch-all returns { events: [] } rather than 500.
    const res = await httpRequest(
      api,
      'GET',
      '/fiber-history/no-such-test-fiber-history?cityId=test',
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.events)).toBe(true);
    // Either empty (felt not found / no history) or populated (felt is on PATH
    // and somehow has a fiber by this name). We only assert the shape.
    for (const ev of res.data.events) {
      expect(typeof ev.occurredAt).toBe('string');
      expect(typeof ev.actor).toBe('string');
      expect(typeof ev.summary).toBe('string');
    }
  });

  it('does not route GET /fiber-history/ to /fiber/ handler', async () => {
    // Guard against the prefix ambiguity: /fiber-history/ must not be caught
    // by the /fiber/ handler before it, which would return a different error.
    const res = await httpRequest(api, 'GET', '/fiber-history/slug?cityId=test');
    // The fiber-history handler sets cityId-aware 404/200, not a fiber-content 400.
    // The response must be JSON with an `events` array or an `error` field —
    // never a fiber-content-shaped response.
    expect(res.data).not.toHaveProperty('slug');
    expect(res.data).not.toHaveProperty('mdast');
  });
});
