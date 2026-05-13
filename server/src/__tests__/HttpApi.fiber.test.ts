/**
 * HttpApi /fiber/:slug endpoint tests.
 *
 * Exercises the vellum-shaped FiberContent endpoint: looks up a fiber by slug
 * within a city, parses frontmatter, and returns an mdast body.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import {
  httpRequest,
  makeCityLookup,
  makeMultiCityLookup,
  writeFiber,
  stubOriginLookup,
  stubPersistenceLookup,
} from './test-utils.js';
import { FiberTreeSnapshotStore } from '../FiberTreeSnapshotStore.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-fiber');

describe('HttpApi — /fiber/:slug endpoint', () => {
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
    const res = await httpRequest(api, 'GET', '/fiber/some-slug');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/cityId/i);
  });

  it('returns 404 for unknown city', async () => {
    const res = await httpRequest(api, 'GET', '/fiber/some-slug?cityId=nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 404 for missing fiber', async () => {
    const res = await httpRequest(api, 'GET', '/fiber/no-such-fiber?cityId=test');
    expect(res.status).toBe(404);
  });

  it('returns mdast + frontmatter + dependencies for a present fiber', async () => {
    writeFiber(
      FELT_DIR,
      'hello-world',
      `---
name: Hello World
status: active
kind: decision
tags:
  - greeting
  - demo
depends-on:
  - foundational-idea
---

This is the body. It references [[another-fiber|another]].
`,
    );

    const res = await httpRequest(api, 'GET', '/fiber/hello-world?cityId=test');
    expect(res.status).toBe(200);
    expect(res.data.slug).toBe('hello-world');
    expect(res.data.kind).toBe('decision');
    expect(res.data.frontmatter.name).toBe('Hello World');
    expect(res.data.frontmatter.tags).toEqual(['greeting', 'demo']);
    expect(res.data.dependencies).toEqual(['foundational-idea']);
    expect(res.data.mdast).toBeTruthy();
    expect(res.data.mdast.type).toBe('root');

    const serialized = JSON.stringify(res.data.mdast);
    expect(serialized).toContain('another-fiber');
    expect(serialized).toContain('another');
  });

  it('rejects path-traversing slugs', async () => {
    const res = await httpRequest(api, 'GET', '/fiber/..%2Fescape?cityId=test');
    expect(res.status).toBe(404);
  });

  it('omits mdast when body is empty', async () => {
    writeFiber(
      FELT_DIR,
      'empty-body',
      `---
name: Empty
status: open
kind: task
---
`,
    );

    const res = await httpRequest(api, 'GET', '/fiber/empty-body?cityId=test');
    expect(res.status).toBe(200);
    expect(res.data.mdast).toBeUndefined();
    expect(res.data.frontmatter.name).toBe('Empty');
  });

  it('returns 404 for markdown files without felt frontmatter', async () => {
    writeFiber(FELT_DIR, 'plain', 'just a paragraph of prose.\n');
    const res = await httpRequest(api, 'GET', '/fiber/plain?cityId=test');
    expect(res.status).toBe(404);
    expect(res.data.error).toContain('not found');
  });

  it('returns the raw fiber markdown for the inline editor', async () => {
    const raw = `---
name: Editable
status: open
---

Body with $C_\\ell$.
`;
    writeFiber(FELT_DIR, 'editable', raw);

    const res = await httpRequest(api, 'GET', '/fiber-raw/editable?cityId=test');

    expect(res.status).toBe(200);
    expect(res.data.slug).toBe('editable');
    expect(res.data.body).toBe(raw);
    expect(res.data.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('replaces raw fiber markdown for the inline editor', async () => {
    writeFiber(FELT_DIR, 'editable', '---\nname: Editable\nstatus: open\n---\n\nOld body\n');
    const next = `---
name: Editable
status: open
---

Updated body
`;

    const res = await httpRequest(api, 'PUT', '/fiber-raw/editable?cityId=test', { body: next });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(readFileSync(join(FELT_DIR, 'editable', 'editable.md'), 'utf8')).toBe(next);
  });

  it('rejects path-traversing raw fiber slugs', async () => {
    const res = await httpRequest(api, 'GET', '/fiber-raw/..%2Fescape?cityId=test');
    expect(res.status).toBe(400);
  });
});

describe('HttpApi — /fiber-locate endpoint', () => {
  const CITY_DIR = join(TEST_DIR, 'locate-city');
  const FELT_DIR = join(CITY_DIR, '.felt');
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(FELT_DIR, { recursive: true });
    api = new HttpApi(
      makeCityLookup('locate', CITY_DIR) as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns 400 without slug', async () => {
    const res = await httpRequest(api, 'GET', '/fiber-locate');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/slug/i);
  });

  it('returns 404 when no city has the slug', async () => {
    const res = await httpRequest(api, 'GET', '/fiber-locate?slug=missing');
    expect(res.status).toBe(404);
  });

  it('resolves a slug to the city that owns it (directory shape)', async () => {
    writeFiber(FELT_DIR, 'my-finding', '---\nname: Found It\n---\nbody\n');
    const res = await httpRequest(api, 'GET', '/fiber-locate?slug=my-finding');
    expect(res.status).toBe(200);
    expect(res.data.cityId).toBe('locate');
    expect(res.data.cityName).toBe('TestCity');
    expect(res.data.cityPath).toBe(CITY_DIR);
    expect(res.data.originId).toBe('local');
  });
});

describe('HttpApi — /fiber-raw remote endpoint', () => {
  const REMOTE_CITY_DIR = '/remote/portolan';
  let remoteStore: FiberTreeSnapshotStore;
  let calls: Array<Record<string, unknown>>;
  let historyCalls: Array<Record<string, unknown>>;
  let api: HttpApi;

  beforeEach(() => {
    remoteStore = new FiberTreeSnapshotStore();
    remoteStore.upsertFullDump('remote-cineca', REMOTE_CITY_DIR, [
      {
        path: 'editable/editable.md',
        fiber: {
          id: 'editable',
          name: 'Editable',
          status: 'active',
          created_at: '2026-05-09T00:00:00Z',
        },
      },
      {
        path: 'remote-note/remote-note.md',
        fiber: {
          id: 'remote-note',
          name: 'Remote Note',
          status: 'active',
          kind: 'finding',
          tags: ['remote', 'vellum'],
          depends_on: [{ id: 'editable' }],
          created_at: '2026-05-10T00:00:00Z',
          body: 'Remote body with [[editable]].',
        },
      },
    ]);
    calls = [];
    historyCalls = [];
    api = new HttpApi(
      makeMultiCityLookup([
        { id: 'remote-city', path: REMOTE_CITY_DIR, name: 'RemoteCity', originId: 'remote-cineca' },
      ]) as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
      {
        remoteSnapshotsProvider: () => remoteStore.getAllSnapshots(),
        remoteRawFiberExecutor: async (request) => {
          calls.push(request);
          if (request.operation === 'read') {
            return { body: '---\nname: Editable\n---\n\nRemote body\n', sha256: 'remote-read-sha' };
          }
          return { sha256: 'remote-write-sha' };
        },
        remoteFiberHistoryExecutor: async (request) => {
          historyCalls.push(request);
          return {
            events: [
              {
                occurred_at: '2026-05-13T12:00:00Z',
                actor: 'tester',
                event_type: 'editorial',
                payload: { text: 'Remote review note' },
              },
            ],
          };
        },
      },
    );
  });

  it('reads raw markdown through the remote raw fiber executor', async () => {
    const res = await httpRequest(api, 'GET', '/fiber-raw/editable?cityId=remote-city');

    expect(res.status).toBe(200);
    expect(res.data.body).toContain('Remote body');
    expect(res.data.sha256).toBe('remote-read-sha');
    expect(calls).toEqual([
      {
        originId: 'remote-cineca',
        feltHost: REMOTE_CITY_DIR,
        path: 'editable/editable.md',
        operation: 'read',
      },
    ]);
  });

  it('writes raw markdown through the remote raw fiber executor', async () => {
    const body = '---\nname: Editable\n---\n\nUpdated remotely\n';

    const res = await httpRequest(api, 'PUT', '/fiber-raw/editable?cityId=remote-city', { body });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.sha256).toBe('remote-write-sha');
    expect(calls).toEqual([
      {
        originId: 'remote-cineca',
        feltHost: REMOTE_CITY_DIR,
        path: 'editable/editable.md',
        operation: 'write',
        body,
      },
    ]);
  });

  it('returns 501 for remote raw reads without agent wiring', async () => {
    const unwired = new HttpApi(
      makeMultiCityLookup([
        { id: 'remote-city', path: REMOTE_CITY_DIR, name: 'RemoteCity', originId: 'remote-cineca' },
      ]) as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
      { remoteSnapshotsProvider: () => remoteStore.getAllSnapshots() },
    );

    const res = await httpRequest(unwired, 'GET', '/fiber-raw/editable?cityId=remote-city');

    expect(res.status).toBe(501);
    expect(res.data.error).toMatch(/remote agent/i);
  });

  it('reads remote fiber history through the remote history executor', async () => {
    const res = await httpRequest(api, 'GET', '/fiber-history/editable?cityId=remote-city');

    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
    expect(res.data.events).toHaveLength(1);
    expect(res.data.events[0].kind).toBe('editorial');
    expect(res.data.events[0].summary).toBe('Remote review note');
    expect(historyCalls).toEqual([
      {
        originId: 'remote-cineca',
        feltHost: REMOTE_CITY_DIR,
        slug: 'editable',
      },
    ]);
  });

  it('renders remote fiber content from the agent snapshot without SSH', async () => {
    const res = await httpRequest(api, 'GET', '/fiber/remote-note?cityId=remote-city');

    expect(res.status).toBe(200);
    expect(res.data.slug).toBe('remote-note');
    expect(res.data.kind).toBe('finding');
    expect(res.data.frontmatter.name).toBe('Remote Note');
    expect(res.data.frontmatter.tags).toEqual(['remote', 'vellum']);
    expect(res.data.dependencies).toEqual(['editable']);
    expect(res.data.mdast).toBeTruthy();
    expect(JSON.stringify(res.data.mdast)).toContain('editable');
  });
});
