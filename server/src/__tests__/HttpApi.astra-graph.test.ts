/**
 * HttpApi /astra/graph endpoint tests
 *
 * Returns a vellum-shaped AstraGraph (nodes + links) for all fibers in a
 * city. Distinct from /tapestry in that it:
 *   - includes every fiber, not just those with `tapestry:`/`rule:` tags
 *   - emits vellum's field names (label/slug, not title/id only)
 *   - tags every link with kind: 'data-flow'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpApi } from '../HttpApi.js';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  httpRequest,
  makeCityLookup,
  writeFiber,
  stubOriginLookup,
  stubPersistenceLookup,
} from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-astra-graph');

describe('HttpApi — /astra/graph endpoint', () => {
  const CITY_DIR = join(TEST_DIR, 'test-city');
  const FELT_DIR = join(CITY_DIR, '.felt');
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(FELT_DIR, { recursive: true });
    // City name matches cityId for the simple cases below; the
    // separate hash-vs-slug regression test installs its own lookup.
    api = new HttpApi(
      makeCityLookup('test', CITY_DIR, 'test') as any,
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
    const res = await httpRequest(api, 'GET', '/astra/graph');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/cityId/i);
  });

  it('returns 404 for unknown city', async () => {
    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns empty graph when city has no fibers', async () => {
    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.status).toBe(200);
    expect(res.data.nodes).toEqual([]);
    expect(res.data.links).toEqual([]);
  });

  it('emits every fiber as a vellum-shaped node', async () => {
    writeFiber(FELT_DIR, 'alpha-abc123', `---
name: Alpha
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
tags:
    - vellum
    - react
---

Alpha body.`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.status).toBe(200);
    expect(res.data.nodes).toHaveLength(1);

    const node = res.data.nodes[0];
    expect(node.id).toBe('alpha-abc123');
    expect(node.slug).toBe('alpha-abc123');
    expect(node.label).toBe('Alpha');
    expect(node.status).toBe('open');
    expect(node.kind).toBe('task');
    expect(node.tags).toEqual(['vellum', 'react']);
    expect(node.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(node.tempered).toBe(false);
    expect(node.hasASTRA).toBe(false);
  });

  it('includes fibers without tapestry/rule tags', async () => {
    writeFiber(FELT_DIR, 'plain-xyz', `---
name: Plain
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.data.nodes).toHaveLength(1);
    expect(res.data.nodes[0].id).toBe('plain-xyz');
  });

  it('emits dependsOn edges with kind "data-flow"', async () => {
    writeFiber(FELT_DIR, 'base', `---
name: Base
status: closed
kind: finding
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);
    writeFiber(FELT_DIR, 'built-on', `---
name: Built on Base
status: open
kind: task
priority: 2
created-at: 2026-01-02T00:00:00Z
depends-on:
    - base
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.data.links).toEqual([
      { source: 'base', target: 'built-on', kind: 'data-flow' },
    ]);
  });

  it('resolves rootSlug to a fiber matching the cityId (loom root-fiber convention)', async () => {
    writeFiber(FELT_DIR, 'test', `---
name: Root
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);
    writeFiber(FELT_DIR, 'other', `---
name: Other
status: open
kind: task
priority: 2
created-at: 2026-01-02T00:00:00Z
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.data.rootSlug).toBe('test');
  });

  it('rootSlug falls back to the first fiber when no id matches the cityId', async () => {
    writeFiber(FELT_DIR, 'alpha', `---
name: Alpha
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.data.rootSlug).toBe('alpha');
  });

  it('rootSlug prefers the root-tagged fiber over the first fiber', async () => {
    writeFiber(FELT_DIR, 'aaa', `---
name: AAA
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);
    writeFiber(FELT_DIR, 'zzz', `---
name: ZZZ
status: open
kind: task
priority: 2
created-at: 2026-01-02T00:00:00Z
tags:
    - root
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.data.rootSlug).toBe('zzz');
  });

  it('rootSlug uses city.name (slug) — cityId is a hash, not a fiber id', async () => {
    // Real-world cityId is a content hash like "14248cabc645e0f987bda6242e35a418"
    // (see CityManager). The root-fiber convention nests by slug, not hash:
    // a fiber id "pure_eb" exists in the pure_eb city, not "14248c…".
    // resolveRootSlug must look up by city.name, not cityId.
    rmSync(FELT_DIR, { recursive: true, force: true });
    const slugDir = join(TEST_DIR, 'slug-city');
    const slugFelt = join(slugDir, '.felt');
    mkdirSync(slugFelt, { recursive: true });
    writeFiber(slugFelt, 'pure_eb', `---
name: pure_eb
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);
    writeFiber(slugFelt, 'aaa', `---
name: AAA
status: open
kind: task
priority: 2
created-at: 2026-01-02T00:00:00Z
---
`);

    const hashCityId = '14248cabc645e0f987bda6242e35a418';
    const slugApi = new HttpApi(
      makeCityLookup(hashCityId, slugDir, 'pure_eb') as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );

    const res = await httpRequest(slugApi, 'GET', `/astra/graph?cityId=${hashCityId}`);
    expect(res.data.rootSlug).toBe('pure_eb');
  });

  it('rootSlug falls back to nested slug/slug convention', async () => {
    rmSync(FELT_DIR, { recursive: true, force: true });
    const slugDir = join(TEST_DIR, 'nested-city');
    const nestedFelt = join(slugDir, '.felt', 'portolan');
    mkdirSync(nestedFelt, { recursive: true });
    writeFiber(nestedFelt, 'portolan', `---
name: Portolan
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);

    const hashCityId = 'abcd1234';
    const slugApi = new HttpApi(
      makeCityLookup(hashCityId, slugDir, 'portolan') as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );

    const res = await httpRequest(slugApi, 'GET', `/astra/graph?cityId=${hashCityId}`);
    expect(res.data.rootSlug).toBe('portolan/portolan');
  });

  it('rootSlug is null when the city has no fibers', async () => {
    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.data.rootSlug).toBeNull();
  });

  it('drops edges that point to fibers outside the city', async () => {
    writeFiber(FELT_DIR, 'orphan-dep', `---
name: Orphan
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
depends-on:
    - some-other-city-fiber
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.data.links).toEqual([]);
    expect(res.data.nodes).toHaveLength(1);
  });
});

describe('HttpApi — /city-root-slug endpoint', () => {
  // Sibling of /astra/graph that returns just { rootSlug } so the vellum
  // modal cold-open doesn't pay the cost of the full graph payload twice.
  // See vellum-dogfood/vellum-modal-double-graph-fetch.
  const CITY_DIR = join(TEST_DIR, 'test-city-root-slug');
  const FELT_DIR = join(CITY_DIR, '.felt');
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(FELT_DIR, { recursive: true });
    api = new HttpApi(
      makeCityLookup('test', CITY_DIR, 'test') as any,
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
    const res = await httpRequest(api, 'GET', '/city-root-slug');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/cityId/i);
  });

  it('returns 404 for unknown city', async () => {
    const res = await httpRequest(api, 'GET', '/city-root-slug?cityId=nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns the rootSlug only — no nodes/links payload', async () => {
    writeFiber(FELT_DIR, 'test', `---
name: Root
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);

    const res = await httpRequest(api, 'GET', '/city-root-slug?cityId=test');
    expect(res.status).toBe(200);
    expect(res.data.rootSlug).toBe('test');
    expect(res.data.nodes).toBeUndefined();
    expect(res.data.links).toBeUndefined();
  });

  it('rootSlug is null when the city has no fibers', async () => {
    const res = await httpRequest(api, 'GET', '/city-root-slug?cityId=test');
    expect(res.status).toBe(200);
    expect(res.data.rootSlug).toBeNull();
  });

  it('uses the same resolution rules as /astra/graph (slug, not hash cityId)', async () => {
    rmSync(FELT_DIR, { recursive: true, force: true });
    const slugDir = join(TEST_DIR, 'slug-city-root-slug');
    const slugFelt = join(slugDir, '.felt');
    mkdirSync(slugFelt, { recursive: true });
    writeFiber(slugFelt, 'pure_eb', `---
name: pure_eb
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);

    const hashCityId = '14248cabc645e0f987bda6242e35a418';
    const slugApi = new HttpApi(
      makeCityLookup(hashCityId, slugDir, 'pure_eb') as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );

    const res = await httpRequest(slugApi, 'GET', `/city-root-slug?cityId=${hashCityId}`);
    expect(res.status).toBe(200);
    expect(res.data.rootSlug).toBe('pure_eb');
  });
});
