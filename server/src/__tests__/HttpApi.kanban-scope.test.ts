/**
 * HttpApi /kanban scope tests — Stage 1 of the vellum-kanban constitution.
 *
 * Exercises the `?cityId=` query-param routing in HttpApi.resolveKanbanApi:
 *
 *   - No cityId → loom-wide default (today: ~/loom; here: env-overridable
 *     via the kanbanApi instance, but we don't probe that path here — the
 *     unit-level kanban behaviour is covered by HttpApiKanban.test.ts).
 *   - cityId resolves to a local-origin city → per-request HttpApiKanban
 *     scoped to city.path. Reads only that city's fibers.
 *   - cityId resolves to a remote-origin city → 400 with a Stage-3 hint.
 *   - Unknown cityId → 400.
 *
 * The fixtures put one fiber under each city's `.felt/` so we can verify
 * that the response columns reflect the scoped tree, not loom-wide.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import {
  httpRequest,
  makeMultiCityLookup,
  stubOriginLookup,
  stubPersistenceLookup,
} from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-kanban-scope');
const CITY_A = join(TEST_DIR, 'city-a');
const CITY_B = join(TEST_DIR, 'city-b');
const CITY_REMOTE = join(TEST_DIR, 'city-remote');

/** Write a directory-shaped constitution fiber under <cityRoot>/.felt/<slug>/<slug>.md. */
function writeConstitutionFiber(
  cityRoot: string,
  slug: string,
  fields: Record<string, string>,
): void {
  const dir = join(cityRoot, '.felt', slug);
  mkdirSync(dir, { recursive: true });
  const fmLines = [
    'tags:',
    '  - constitution',
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
  ];
  const content = `---\n${fmLines.join('\n')}\n---\n\nbody\n`;
  writeFileSync(join(dir, `${slug}.md`), content, 'utf-8');
}

describe('HttpApi — /kanban ?cityId= scope', () => {
  let api: HttpApi;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(CITY_A, { recursive: true });
    mkdirSync(CITY_B, { recursive: true });
    mkdirSync(CITY_REMOTE, { recursive: true });

    // Distinct fibers in each tree so the test can prove which one we read.
    writeConstitutionFiber(CITY_A, 'a-only-fiber', {
      name: 'A-only',
      status: 'active',
      'created-at': '2026-04-15T00:00:00Z',
    });
    writeConstitutionFiber(CITY_B, 'b-only-fiber', {
      name: 'B-only',
      status: 'active',
      'created-at': '2026-04-16T00:00:00Z',
    });
    writeConstitutionFiber(CITY_REMOTE, 'remote-only-fiber', {
      name: 'Remote-only',
      status: 'active',
      'created-at': '2026-04-17T00:00:00Z',
    });

    const cityLookup = makeMultiCityLookup([
      { id: 'a', path: CITY_A, name: 'CityA' },
      { id: 'b', path: CITY_B, name: 'CityB' },
      { id: 'r', path: CITY_REMOTE, name: 'CityRemote', originId: 'remote-elsewhere' },
    ]);
    api = new HttpApi(
      cityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('GET /kanban?cityId=a returns only city-A fibers', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=a');
    expect(res.status).toBe(200);
    expect(res.data.feltHost).toBe(CITY_A);
    const ids = (res.data.columns.inFlight as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain('a-only-fiber');
    expect(ids).not.toContain('b-only-fiber');
    expect(ids).not.toContain('remote-only-fiber');
  });

  it('GET /kanban?cityId=b returns only city-B fibers', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=b');
    expect(res.status).toBe(200);
    expect(res.data.feltHost).toBe(CITY_B);
    const ids = (res.data.columns.inFlight as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain('b-only-fiber');
    expect(ids).not.toContain('a-only-fiber');
  });

  it('GET /kanban?cityId=unknown returns 400', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=does-not-exist');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/unknown cityId/);
  });

  it('GET /kanban?cityId=<remote> returns 400 with Stage-3 hint', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=r');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/remote origin/);
    expect(res.data.error).toMatch(/Stage 3/);
  });

  it('POST /kanban/transition?cityId=<unknown> returns 400 (does not mutate)', async () => {
    const res = await httpRequest(
      api,
      'POST',
      '/kanban/transition?cityId=does-not-exist',
      { fiberId: 'a-only-fiber', target: 'awaitingReview' },
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/unknown cityId/);
  });

  it('POST /kanban/transition?cityId=<remote> returns 400 (Stage-3 boundary)', async () => {
    const res = await httpRequest(
      api,
      'POST',
      '/kanban/transition?cityId=r',
      { fiberId: 'remote-only-fiber', target: 'awaitingReview' },
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/remote origin/);
  });

  it('POST /kanban/transition?cityId=a mutates the city-A fiber, not loom', async () => {
    const res = await httpRequest(
      api,
      'POST',
      '/kanban/transition?cityId=a',
      { fiberId: 'a-only-fiber', target: 'awaitingReview' },
    );
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.card.status).toBe('closed');
    expect(res.data.card.tempered).toBe(false);
  });

  it('POST /kanban/transition?cityId=a refuses to operate on a fiber from another city', async () => {
    // city-B's fiber doesn't exist under city-A's tree → should 5xx with
    // "fiber not found", not silently fall back to loom.
    const res = await httpRequest(
      api,
      'POST',
      '/kanban/transition?cityId=a',
      { fiberId: 'b-only-fiber', target: 'awaitingReview' },
    );
    expect(res.status).toBe(500);
    expect(res.data.error).toMatch(/fiber not found/);
  });
});
