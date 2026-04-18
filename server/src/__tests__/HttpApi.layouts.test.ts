/**
 * HttpApi /layouts/:cityId endpoint tests.
 *
 * Exercises map-pinned vellum card persistence: list / upsert / delete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
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
      makeCityLookup('city-a', '/tmp/test-portolan-city') as any,
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
    const put = await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 4, z: -2, kind: 'fiber' });
    expect(put.status).toBe(200);
    expect(put.data.pin).toMatchObject({ slug: 'fiber-1', x: 4, z: -2, kind: 'fiber' });

    const list = await httpRequest(api, 'GET', '/layouts/city-a');
    expect(list.data.pins).toHaveLength(1);
    expect(list.data.pins[0]).toMatchObject({ slug: 'fiber-1', x: 4, z: -2, kind: 'fiber' });
  });

  it('PUT accepts width/height and persists them', async () => {
    const put = await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', {
      x: 4, z: -2, kind: 'fiber', width: 520, height: 360,
    } as any);
    expect(put.status).toBe(200);
    expect(put.data.pin).toMatchObject({ width: 520, height: 360 });
    // A second PUT that omits size must preserve the previous dimensions.
    const reposition = await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 1, z: 1 });
    expect(reposition.data.pin).toMatchObject({ x: 1, z: 1, width: 520, height: 360 });
  });

  it('PUT rejects out-of-bounds width/height with 400', async () => {
    const tooBig = await httpRequest(api, 'PUT', '/layouts/city-a/pins/s', {
      x: 0, z: 0, kind: 'fiber', width: 99999,
    } as any);
    expect(tooBig.status).toBe(400);
  });

  it('PUT with bad body returns 400', async () => {
    const res = await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 'oops' } as any);
    expect(res.status).toBe(400);
  });

  it('PUT records cityKey from cityLookup so orphan files trace back to a path', async () => {
    await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 1, z: 1, kind: 'fiber' });
    const file = join(TEST_DIR, 'layouts', 'city-a.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.cityKey).toBe('local:/tmp/test-portolan-city');
  });

  it('PUT against unknown cityId is rejected (no cityKey available)', async () => {
    const res = await httpRequest(api, 'PUT', '/layouts/city-unknown/pins/fiber-1', { x: 1, z: 1, kind: 'fiber' });
    expect(res.status).toBe(400);
    const file = join(TEST_DIR, 'layouts', 'city-unknown.json');
    expect(existsSync(file)).toBe(false);
  });

  it('GET /layouts/_diagnostics classifies live, orphan, and mismatch files', async () => {
    // Build a cityLookup whose live city has the realistic
    // cityId = stableCityId(`${originId}:${path}`) relationship.
    const { stableCityId } = await import('../CityManager.js');
    const livePath = '/tmp/test-portolan-city';
    const liveKey = `local:${livePath}`;
    const liveId = stableCityId(liveKey);
    const cities = [{ id: liveId, path: livePath, originId: 'local' }];
    (api as any).cityLookup = {
      getCityById: (id: string) =>
        cities.find(c => c.id === id) ?? null,
      getCityKey: (id: string) => {
        const c = cities.find(c => c.id === id);
        return c ? `${c.originId}:${c.path}` : null;
      },
      getCities: () => cities,
    };
    // Re-instantiate the layouts subapi so it picks up the new lookup.
    const layoutStore = (api as any).layoutStore;
    const HttpApiLayouts = (await import('../HttpApiLayouts.js')).HttpApiLayouts;
    (api as any).layoutsApi = new HttpApiLayouts({
      layoutStore,
      parseJsonBody: (req: any, res: any) => (api as any).parseJsonBody(req, res),
      sendJsonError: (res: any, status: number, error: string) => (api as any).sendJsonError(res, status, error),
      sendJsonSuccess: (res: any, data: any) => (api as any).sendJsonSuccess(res, data),
      cityLookup: (api as any).cityLookup,
    });

    // Seed: a "live" pin, an "orphan" pin (cityKey points at unknown id),
    // and a "mismatch" file (cityKey doesn't hash to cityId).
    await httpRequest(api, 'PUT', `/layouts/${liveId}/pins/fiber-1`, { x: 1, z: 1, kind: 'fiber' });

    // Synthesize on-disk orphan / mismatch by writing files directly.
    const { writeFileSync, mkdirSync } = await import('fs');
    const layoutsDir = join(TEST_DIR, 'layouts');
    mkdirSync(layoutsDir, { recursive: true });
    // orphan: cityKey hashes to cityId, but no live city has it
    const orphanKey = 'local:/tmp/dead-project';
    const orphanId = stableCityId(orphanKey);
    writeFileSync(join(layoutsDir, `${orphanId}.json`), JSON.stringify({
      version: 1, cityId: orphanId, cityKey: orphanKey,
      pins: [{ slug: 'p', x: 0, z: 0, pinnedAt: 1, kind: 'fiber' }],
    }));
    // mismatch: cityKey doesn't hash to filename's cityId
    writeFileSync(join(layoutsDir, 'badhash000000000000000000000000.json'), JSON.stringify({
      version: 1, cityId: 'badhash000000000000000000000000', cityKey: 'local:/somewhere',
      pins: [{ slug: 'p', x: 0, z: 0, pinnedAt: 1, kind: 'fiber' }],
    }));
    // Bust the LayoutStore cache so on-disk reads pick up the seeded files.
    (api as any).layoutStore.cache.clear();

    const res = await httpRequest(api, 'GET', '/layouts/_diagnostics');
    expect(res.status).toBe(200);
    const byStatus = Object.fromEntries(
      res.data.layouts.map((l: any) => [l.status, l]),
    );
    expect(byStatus.live?.cityId).toBe(liveId);
    expect(byStatus.orphan?.cityId).toBe(orphanId);
    expect(byStatus.mismatch?.cityId).toBe('badhash000000000000000000000000');
    expect(byStatus.unkeyed).toBeUndefined();
    expect(byStatus.live.pinCount).toBe(1);
  });

  it('PUT accepts kind and source extras for non-fiber pins', async () => {
    const source = { originId: 'local', path: '/abs/paper.pdf' };
    const put = await httpRequest(api, 'PUT', '/layouts/city-a/pins/file-deadbeef', {
      x: 1, z: 2, kind: 'pdf', source,
    });
    expect(put.status).toBe(200);
    expect(put.data.pin).toMatchObject({ slug: 'file-deadbeef', kind: 'pdf', source });
  });

  it('PUT rejects unknown kind', async () => {
    const res = await httpRequest(api, 'PUT', '/layouts/city-a/pins/p', {
      x: 0, z: 0, kind: 'spaceship',
    });
    expect(res.status).toBe(400);
  });

  it('POST /files derives a stable slug and persists the pin', async () => {
    const source = { originId: 'local', path: '/abs/paper.pdf' };
    const first = await httpRequest(api, 'POST', '/layouts/city-a/files', {
      x: 4, z: -2, source,
    });
    expect(first.status).toBe(200);
    expect(first.data.pin.slug).toMatch(/^file-/);
    expect(first.data.pin.kind).toBe('pdf'); // inferred from extension
    expect(first.data.pin.source).toEqual(source);

    // Re-pinning the same source updates in place — same slug.
    const second = await httpRequest(api, 'POST', '/layouts/city-a/files', {
      x: 5, z: 5, source,
    });
    expect(second.data.pin.slug).toBe(first.data.pin.slug);
    expect(second.data.pin.x).toBe(5);

    const list = await httpRequest(api, 'GET', '/layouts/city-a');
    expect(list.data.pins).toHaveLength(1);
  });

  it('POST /files accepts a URL source and infers kind=other', async () => {
    const res = await httpRequest(api, 'POST', '/layouts/city-a/files', {
      x: 0, z: 0, source: { url: 'https://arxiv.org/abs/2401.00001' },
    });
    expect(res.status).toBe(200);
    expect(res.data.pin.slug).toMatch(/^url-/);
    expect(res.data.pin.kind).toBe('other');
  });

  it('POST /files rejects ambiguous source', async () => {
    const res = await httpRequest(api, 'POST', '/layouts/city-a/files', {
      x: 0, z: 0, source: { originId: 'local', path: '/a', url: 'https://x' },
    });
    expect(res.status).toBe(400);
  });

  it('DELETE removes the pin', async () => {
    await httpRequest(api, 'PUT', '/layouts/city-a/pins/fiber-1', { x: 0, z: 0, kind: 'fiber' });
    const del = await httpRequest(api, 'DELETE', '/layouts/city-a/pins/fiber-1');
    expect(del.status).toBe(200);
    expect(del.data.removed).toBe(true);

    const list = await httpRequest(api, 'GET', '/layouts/city-a');
    expect(list.data.pins).toEqual([]);
  });
});
