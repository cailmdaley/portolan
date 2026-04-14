/**
 * HttpApi /layouts/:cityId endpoint tests.
 *
 * Exercises map-pinned vellum card persistence: list / upsert / delete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import {
  httpRequest,
  makeCityLookup,
  stubOriginLookup,
  stubPersistenceLookup,
} from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-layouts');

describe('HttpApi — /layouts/:cityId endpoints', () => {
  let api: HttpApi;

  beforeEach(() => {
    api = new HttpApi(
      makeCityLookup('test', '/tmp/irrelevant') as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
    // Redirect LayoutStore to a test directory.
    const store = (api as any).layoutStore;
    store.dataDir = TEST_DIR;
    store.layoutsDir = join(TEST_DIR, 'layouts');
    store.cache.clear();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('GET returns empty pins for a fresh city', async () => {
    const res = await httpRequest(api, 'GET', '/layouts/city-a');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ cityId: 'city-a', pins: [] });
  });

  it('PUT upserts a pin then GET returns it', async () => {
    const put = await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 4, z: -2 });
    expect(put.status).toBe(200);
    expect(put.data.pin).toMatchObject({ slug: 'fiber-1', x: 4, z: -2 });

    const list = await httpRequest(api, 'GET', '/layouts/city-a');
    expect(list.data.pins).toHaveLength(1);
    expect(list.data.pins[0]).toMatchObject({ slug: 'fiber-1', x: 4, z: -2 });
  });

  it('PUT with bad body returns 400', async () => {
    const res = await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 'oops' } as any);
    expect(res.status).toBe(400);
  });

  it('DELETE removes the pin', async () => {
    await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 0, z: 0 });
    const del = await httpRequest(api, 'DELETE', '/layouts/city-a/pins/fiber-1');
    expect(del.status).toBe(200);
    expect(del.data.removed).toBe(true);

    const list = await httpRequest(api, 'GET', '/layouts/city-a');
    expect(list.data.pins).toEqual([]);
  });
});
