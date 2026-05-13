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
 *   - cityId resolves to a remote-origin city → origin-scoped snapshot view.
 *   - Unknown cityId → 400.
 *
 * The fixtures put one fiber under each city's `.felt/` so we can verify
 * that the response columns reflect the scoped tree, not loom-wide.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import type { ShuttleCtlInvocation } from '../HttpApiKanban.js';
import { FiberTreeSnapshotStore } from '../FiberTreeSnapshotStore.js';
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

/** Write a directory-shaped shuttle-managed fiber under <cityRoot>/.felt/<slug>/<slug>.md. */
function writeConstitutionFiber(
  cityRoot: string,
  slug: string,
  fields: Record<string, string>,
): void {
  const dir = join(cityRoot, '.felt', slug);
  mkdirSync(dir, { recursive: true });
  const fmLines = [
    'shuttle:',
    '  enabled: true',
    '  kind: oneshot',
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
  ];
  const content = `---\n${fmLines.join('\n')}\n---\n\nbody\n`;
  writeFileSync(join(dir, `${slug}.md`), content, 'utf-8');
}

/**
 * Test-only shuttle-ctl stub. The HttpApi-level path now routes every local
 * transition through `shuttle-ctl` (refactor 62733fe — single YAML writer
 * for the shuttle block + felt scalars). The test fixtures live outside
 * loom, so the real binary's `felt ls`-based id resolution can't find them;
 * we substitute a minimal in-process writer that mutates the same fields
 * shuttle-ctl would. Mirrors the canonical version in HttpApiKanban.test.ts.
 */
function applyShuttleCtlStub(
  invocation: ShuttleCtlInvocation,
  _cityRoots: string[],
  nowIso = '2026-05-05T00:00:00.000Z',
): void {
  const slug = invocation.fiberId;
  const segments = slug.split('/');
  const basename = segments[segments.length - 1];
  const path = join(invocation.host, '.felt', ...segments, `${basename}.md`);
  if (!existsSync(path)) {
    throw new Error(`shuttle-ctl stub: fiber not found at ${path}`);
  }

  let raw = readFileSync(path, 'utf-8');
  const setScalar = (key: string, value: string): void => {
    const re = new RegExp(`^([\\t ]*${key}:[\\t ]*).*$`, 'm');
    raw = re.test(raw) ? raw.replace(re, `$1${value}`) : raw + `\n${key}: ${value}`;
  };
  const setEnabled = (val: 'true' | 'false'): void => {
    raw = raw.replace(/^(\s*enabled:\s*)(true|false)$/m, `$1${val}`);
  };
  switch (invocation.verb) {
    case 'pause': {
      setEnabled('false');
      break;
    }
    case 'reopen': {
      setScalar('status', 'active');
      setEnabled('true');
      // Clear closed-at + tempered fields if present.
      raw = raw.replace(/^closed-at:.*$\n?/m, '');
      raw = raw.replace(/^tempered:.*$\n?/m, '');
      break;
    }
    case 'close': {
      setScalar('status', 'closed');
      if (!/^closed-at:/m.test(raw)) raw = raw.replace(/^---\n/, `---\nclosed-at: ${nowIso}\n`);
      if (invocation.tempered === undefined) {
        raw = raw.replace(/^tempered:.*$\n?/m, '');
      } else {
        setScalar('tempered', invocation.tempered ? 'true' : 'false');
      }
      break;
    }
    case 'accept': {
      setEnabled('true');
      break;
    }
  }
  writeFileSync(path, raw, 'utf-8');
}

describe('HttpApi — /kanban ?cityId= scope', () => {
  let api: HttpApi;
  let remoteStore: FiberTreeSnapshotStore;

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

    remoteStore = new FiberTreeSnapshotStore();
    remoteStore.upsertFullDump('remote-elsewhere', '/remote/loom', [
      {
        path: 'remote-snapshot-fiber/remote-snapshot-fiber.md',
        fiber: {
          id: 'remote-snapshot-fiber',
          name: 'Remote snapshot',
          status: 'active',
          shuttle: { enabled: true, kind: 'oneshot' },
          created_at: '2026-04-18T00:00:00Z',
        },
      },
    ]);

    const cityLookup = makeMultiCityLookup([
      { id: 'a', path: CITY_A, name: 'CityA' },
      { id: 'b', path: CITY_B, name: 'CityB' },
      { id: 'r', path: CITY_REMOTE, name: 'CityRemote', originId: 'remote-elsewhere' },
    ]);
    const cityRoots = [CITY_A, CITY_B, CITY_REMOTE];
    api = new HttpApi(
      cityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
      {
        remoteSnapshotsProvider: () => remoteStore.getAllSnapshots(),
        shuttleCtlFn: async (invocation) => applyShuttleCtlStub(invocation, cityRoots),
      },
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('GET /kanban?cityId=a returns only city-A fibers', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=a');
    expect(res.status).toBe(200);
    expect(res.data.feltHost).toBe(CITY_A);
    const ids = (res.data.now.inFlight as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain('a-only-fiber');
    expect(ids).not.toContain('b-only-fiber');
    expect(ids).not.toContain('remote-only-fiber');
  });

  it('GET /kanban?cityId=b returns only city-B fibers', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=b');
    expect(res.status).toBe(200);
    expect(res.data.feltHost).toBe(CITY_B);
    const ids = (res.data.now.inFlight as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain('b-only-fiber');
    expect(ids).not.toContain('a-only-fiber');
  });

  it('GET /kanban?cityId=unknown returns 400', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=does-not-exist');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/unknown cityId/);
  });

  it('GET /kanban?cityId=<remote> does not fall back to an origin-wide loom snapshot', async () => {
    const res = await httpRequest(api, 'GET', '/kanban?cityId=r');
    expect(res.status).toBe(200);
    expect(res.data.remoteScope).toEqual({
      originId: 'remote-elsewhere',
      hostname: 'elsewhere',
    });
    expect(res.data.staleness['remote-elsewhere']).toEqual({
      status: 'stale',
      hostname: 'elsewhere',
    });
    expect(res.data.totals.inFlight).toBe(0);
  });

  it('GET /kanban?cityId=<remote> returns that remote city snapshot when rooted at the city path', async () => {
    remoteStore.upsertFullDump('remote-elsewhere', CITY_REMOTE, [
      {
        path: 'remote-snapshot-fiber/remote-snapshot-fiber.md',
        fiber: {
          id: 'remote-snapshot-fiber',
          name: 'Remote snapshot',
          status: 'active',
          shuttle: { enabled: true, kind: 'oneshot' },
          created_at: '2026-04-18T00:00:00Z',
        },
      },
    ]);
    const res = await httpRequest(api, 'GET', '/kanban?cityId=r');
    expect(res.status).toBe(200);
    expect(res.data.remoteScope).toEqual({
      originId: 'remote-elsewhere',
      hostname: 'elsewhere',
    });
    const ids = (res.data.now.inFlight as Array<{ id: string; originId: string }>).map((c) => [c.id, c.originId]);
    expect(ids).toEqual([['remote-snapshot-fiber', 'remote-elsewhere']]);
  });

  it('GET /kanban?cityId=<remote> reports disconnected when no snapshot has arrived', async () => {
    remoteStore = new FiberTreeSnapshotStore();
    const res = await httpRequest(api, 'GET', '/kanban?cityId=r');
    expect(res.status).toBe(200);
    expect(res.data.remoteScope).toEqual({
      originId: 'remote-elsewhere',
      hostname: 'elsewhere',
    });
    expect(res.data.staleness['remote-elsewhere']).toEqual({
      status: 'stale',
      hostname: 'elsewhere',
    });
    expect(res.data.totals.inFlight).toBe(0);
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

  it('POST /kanban/transition?cityId=<remote> reaches the remote snapshot boundary', async () => {
    remoteStore.upsertFullDump('remote-elsewhere', CITY_REMOTE, [
      {
        path: 'remote-snapshot-fiber/remote-snapshot-fiber.md',
        fiber: {
          id: 'remote-snapshot-fiber',
          name: 'Remote snapshot',
          status: 'active',
          shuttle: { enabled: true, kind: 'oneshot' },
          created_at: '2026-04-18T00:00:00Z',
        },
      },
    ]);
    const res = await httpRequest(
      api,
      'POST',
      '/kanban/transition?cityId=r',
      { fiberId: 'remote-snapshot-fiber', target: 'awaitingReview' },
    );
    expect(res.status).toBe(500);
    expect(res.data.error).toMatch(/remoteTransitionExecutor/);
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
    expect(res.data.card.tempered).toBeUndefined();
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

  it('invalidates global kanban cache when a nested city .felt symlink appears', async () => {
    const loom = join(TEST_DIR, 'loom');
    const aiFutures = join(TEST_DIR, 'ai-futures');
    const shuttle = join(TEST_DIR, 'shuttle');
    mkdirSync(join(loom, '.felt', 'ai-futures', 'shuttle', 'work'), { recursive: true });
    mkdirSync(aiFutures, { recursive: true });
    mkdirSync(shuttle, { recursive: true });
    symlinkSync(join(loom, '.felt', 'ai-futures'), join(aiFutures, '.felt'));
    writeFileSync(
      join(loom, '.felt', 'ai-futures', 'shuttle', 'work', 'work.md'),
      [
        '---',
        'name: Shuttle work',
        'status: active',
        'shuttle:',
        '  enabled: true',
        '  kind: oneshot',
        'created-at: 2026-05-01T00:00:00Z',
        '---',
        '',
        'body',
      ].join('\n'),
      'utf-8',
    );

    const cities = [
      { id: 'loom', path: loom, name: 'loom', originId: 'local' },
      { id: 'ai-futures', path: aiFutures, name: 'ai-futures', originId: 'local' },
      { id: 'shuttle', path: shuttle, name: 'shuttle', originId: 'local' },
    ];
    const globalApi = new HttpApi(
      makeMultiCityLookup(cities) as any,
      stubOriginLookup as any,
      { ...stubPersistenceLookup, getCities: () => cities } as any,
    );

    const before = await httpRequest(globalApi, 'GET', '/kanban');
    const beforeCard = before.data.now.inFlight.find((c: any) => c.id === 'ai-futures/shuttle/work');
    expect(beforeCard.cityId).toBe('ai-futures');
    expect(beforeCard.projectSlug).toBe('shuttle/work');

    symlinkSync(join(loom, '.felt', 'ai-futures', 'shuttle'), join(shuttle, '.felt'));

    const after = await httpRequest(globalApi, 'GET', '/kanban');
    const afterCard = after.data.now.inFlight.find((c: any) => c.id === 'ai-futures/shuttle/work');
    expect(afterCard.cityId).toBe('shuttle');
    expect(afterCard.projectSlug).toBe('work');
  });
});
