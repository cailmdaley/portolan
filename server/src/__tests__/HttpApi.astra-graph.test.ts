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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  httpRequest,
  makeCityLookup,
  writeFiber,
  stubOriginLookup,
  stubPersistenceLookup,
} from './test-utils.js';

/**
 * Write a nested fiber at <feltDir>/<id>/<basename(id)>.md. test-utils'
 * `writeFiber` builds `slug.md` inside the leaf directory, which works for
 * non-nested slugs ("foo" → foo/foo.md) but mis-builds when slug contains
 * a slash ("a/b" → a/b/a/b.md, double-nested). The directory layout vellum
 * and FiberReader expect is `a/b/b.md`.
 */
function writeNestedFiber(feltDir: string, id: string, content: string): void {
  const dir = join(feltDir, id);
  mkdirSync(dir, { recursive: true });
  const basename = id.split('/').pop() ?? id;
  writeFileSync(join(dir, `${basename}.md`), content, 'utf-8');
}

/**
 * Strip the cross-city / city-as-parent augmentation
 * (`__loom__` parent, `__city__:cityId` sibling gateways, and the
 * loom→root + root→top-level contains-links injected for them) so the
 * tests can assert on the city's *own* fibers and links. The
 * augmentation is exercised in its own test below.
 */
function stripAugmentation(graph: { nodes: any[]; links: any[] }): { nodes: any[]; links: any[] } {
  const isSynth = (id: string) => id === '__loom__' || id.startsWith('__city__:');
  return {
    nodes: graph.nodes.filter((n) => !isSynth(n.id)),
    links: graph.links.filter((l) => !isSynth(l.source) && !isSynth(l.target)),
  };
}

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
    const stripped = stripAugmentation(res.data);
    expect(stripped.nodes).toEqual([]);
    expect(stripped.links).toEqual([]);
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
    const stripped = stripAugmentation(res.data);
    expect(stripped.nodes).toHaveLength(1);

    const node = stripped.nodes[0];
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
    const stripped = stripAugmentation(res.data);
    expect(stripped.nodes).toHaveLength(1);
    expect(stripped.nodes[0].id).toBe('plain-xyz');
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
    const stripped = stripAugmentation(res.data);
    // Filter to data-flow links only — resolveRootSlug's last-resort
    // fallback elevates `allFibers[0]` (here: `base`) as a virtual root
    // when nothing else matches the cityName, which then triggers the
    // city-as-parent augmentation's `rootSlug → other-top-level`
    // contains-links. That's tested separately; this test cares only
    // about the dependsOn → data-flow translation.
    const dataFlowLinks = stripped.links.filter((l: any) => l.kind === 'data-flow');
    expect(dataFlowLinks).toEqual([
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
    const stripped = stripAugmentation(res.data);
    expect(stripped.links).toEqual([]);
    expect(stripped.nodes).toHaveLength(1);
  });

  it('emits "contains" edges from the slug-shape parent for nested fibers', async () => {
    // .felt/parent/parent.md (the container)
    writeFiber(FELT_DIR, 'parent', `---
name: Parent
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);
    // .felt/parent/child/child.md (id "parent/child", lives under parent/)
    writeNestedFiber(FELT_DIR, 'parent/child', `---
name: Child
status: open
kind: task
priority: 2
created-at: 2026-01-02T00:00:00Z
---
`);
    // .felt/parent/child/grandchild/grandchild.md
    writeNestedFiber(FELT_DIR, 'parent/child/grandchild', `---
name: Grandchild
status: open
kind: task
priority: 2
created-at: 2026-01-03T00:00:00Z
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    expect(res.status).toBe(200);
    const stripped = stripAugmentation(res.data);
    // Strip the city-as-parent intra-city links too: with rootSlug='test'
    // (no such fiber here) the augmentation is silent, but if it ever
    // fires for this shape we want the assertion to stay focused on the
    // slug-shape contains-derivation that this test exercises.
    const containsLinks = stripped.links.filter((l: any) => l.kind === 'contains');
    expect(containsLinks).toEqual(
      expect.arrayContaining([
        { source: 'parent', target: 'parent/child', kind: 'contains' },
        { source: 'parent/child', target: 'parent/child/grandchild', kind: 'contains' },
      ]),
    );
    expect(containsLinks).toHaveLength(2);
  });

  it('omits "contains" edges when the parent slug has no fiber (no orphan-rooting)', async () => {
    // Nested slug whose parent slug doesn't have its own fiber file.
    // Without a real parent fiber, vellum's IndexView should still surface
    // this as a top-level entry rather than dangle from a phantom parent.
    writeNestedFiber(FELT_DIR, 'lonely-branch/leaf', `---
name: Leaf
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---
`);

    const res = await httpRequest(api, 'GET', '/astra/graph?cityId=test');
    const stripped = stripAugmentation(res.data);
    expect(stripped.links.filter((l: any) => l.kind === 'contains')).toEqual([]);
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
