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
title: Alpha
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
title: Plain
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
title: Base
status: closed
kind: finding
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);
    writeFiber(FELT_DIR, 'built-on', `---
title: Built on Base
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

  it('drops edges that point to fibers outside the city', async () => {
    writeFiber(FELT_DIR, 'orphan-dep', `---
title: Orphan
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
