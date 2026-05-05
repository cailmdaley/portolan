/**
 * HttpApiGlobalSearch — cross-project fiber search.
 *
 * Stage 2 of constitution-portolan-navigation-layer. The endpoint mirrors
 * HttpApiTapestry.handleSearch's score model but spans every pinned felt
 * host plus pushed remote snapshots, with realpath/id dedupe so a fiber
 * visible through a loom symlink doesn't double-count.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApiGlobalSearch } from '../HttpApiGlobalSearch.js';
import type { FiberTreeSnapshot } from '../FiberTreeSnapshotStore.js';
import type { Fiber } from '../FiberReader.js';
import { writeFiber } from './test-utils.js';

/** Like writeFiber but supports nested slugs (e.g. `design/foo` → `design/foo/foo.md`). */
function writeNestedFiber(feltDir: string, slug: string, content: string): void {
  const dir = join(feltDir, slug);
  const basename = slug.split('/').pop()!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename}.md`), content, 'utf-8');
}

const TEST_ROOT = join(homedir(), '.portolan-test-global-search');

function mockFiber(id: string, overrides: Partial<Fiber> = {}): Fiber {
  return {
    id,
    name: id,
    status: 'open',
    kind: 'task',
    priority: 2,
    createdAt: '',
    ...overrides,
  };
}

describe('HttpApiGlobalSearch', () => {
  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns empty hits for empty query', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeFiber(join(cityPath, '.felt'), 'foo', '---\nname: Foo\nstatus: open\n---\n\nFoo body.');
    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'city-a', path: cityPath }],
    });
    const hits = await api.search('', 30);
    expect(hits).toEqual([]);
  });

  it('scores name match higher than body match', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeFiber(
      join(cityPath, '.felt'),
      'shuttle-design',
      '---\nname: Shuttle design\nstatus: active\n---\n\nUnrelated body content.',
    );
    writeFiber(
      join(cityPath, '.felt'),
      'unrelated',
      '---\nname: Unrelated\nstatus: open\n---\n\nThis body mentions shuttle once.',
    );
    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'city-a', path: cityPath }],
    });
    const hits = await api.search('shuttle', 10);
    expect(hits.length).toBe(2);
    expect(hits[0].id).toBe('shuttle-design'); // name hit (100)
    expect(hits[1].id).toBe('unrelated'); // body hit (5)
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('resolves cityId + projectSlug via realpath when fiber is under a pinned city', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeNestedFiber(
      join(cityPath, '.felt'),
      'design/constitution-foo',
      '---\nname: Constitution foo\nstatus: active\n---\n',
    );
    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'city-a', path: cityPath }],
    });
    const hits = await api.search('constitution', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].cityId).toBe('city-a');
    expect(hits[0].projectSlug).toBe('design/constitution-foo');
    // The exposed `id` is the project-relative slug for click-through.
    expect(hits[0].id).toBe('design/constitution-foo');
  });

  it('dedupes a fiber visible through both a project and a loom symlink', async () => {
    // Physical project city
    const cityPath = join(TEST_ROOT, 'project-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeFiber(
      join(cityPath, '.felt'),
      'shared-fiber',
      '---\nname: Shared fiber\nstatus: open\n---\n',
    );

    // Loom host: its `.felt/<scope>/project-a` symlinks to the project's `.felt/`
    const loomHost = join(TEST_ROOT, 'loom');
    const loomScope = join(loomHost, '.felt', 'ai-futures');
    mkdirSync(loomScope, { recursive: true });
    symlinkSync(join(cityPath, '.felt'), join(loomScope, 'project-a'));

    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath, loomHost],
      cities: [{ id: 'project-a', path: cityPath }],
    });
    const hits = await api.search('shared', 10);
    // Even though loom would expose the fiber as `ai-futures/project-a/shared-fiber`,
    // realpath-dedupe collapses to the first-seen entry (the project city).
    expect(hits.length).toBe(1);
    expect(hits[0].cityId).toBe('project-a');
    expect(hits[0].projectSlug).toBe('shared-fiber');
  });

  it('folds in remote-origin snapshots, with id-dedupe against local', async () => {
    const localPath = join(TEST_ROOT, 'local-city');
    mkdirSync(join(localPath, '.felt'), { recursive: true });
    writeFiber(
      join(localPath, '.felt'),
      'local-only',
      '---\nname: Local only\nstatus: active\n---\n',
    );

    const remoteOnly = mockFiber('remote-only', { name: 'Remote only', status: 'open' });
    const collidingId = mockFiber('local-only', { name: 'Stale remote mirror', status: 'closed' });
    const snapshot: FiberTreeSnapshot = {
      originId: 'remote-cineca',
      feltHost: '/home/cd/loom',
      fibers: [remoteOnly, collidingId],
      byId: new Map([
        [remoteOnly.id, remoteOnly],
        [collidingId.id, collidingId],
      ]),
      lastFullDump: new Date(),
      status: 'fresh',
    };

    const api = new HttpApiGlobalSearch({
      feltHosts: [localPath],
      cities: [{ id: 'local-city', path: localPath }],
      remoteSnapshotsProvider: () => [snapshot],
    });

    const allHits = await api.search('only', 10);
    const ids = allHits.map((h) => h.id).sort();
    // Remote `local-only` collides on id with local — local wins, only the
    // remote-only id is added from the snapshot.
    expect(ids).toEqual(['local-only', 'remote-only']);

    const remoteHit = allHits.find((h) => h.id === 'remote-only');
    expect(remoteHit?.originId).toBe('remote-cineca');
    expect(remoteHit?.hostname).toBe('cineca');
    expect(remoteHit?.cityId).toBeUndefined();

    const localHit = allHits.find((h) => h.id === 'local-only');
    expect(localHit?.originId).toBe('local');
    // The colliding remote name doesn't show — local entry is canonical.
    expect(localHit?.name).toBe('Local only');
  });

  it('honors the limit parameter', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    for (let i = 0; i < 8; i++) {
      writeFiber(
        join(cityPath, '.felt'),
        `match-${i}`,
        `---\nname: Match ${i}\nstatus: open\n---\n`,
      );
    }
    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'city-a', path: cityPath }],
    });
    const hits = await api.search('match', 3);
    expect(hits.length).toBe(3);
  });

  it('produces a body snippet around the matched needle', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeFiber(
      join(cityPath, '.felt'),
      'long-fiber',
      '---\nname: Long fiber\nstatus: open\n---\n\n' +
        'Lorem ipsum dolor sit amet. The needle word lives here in the middle. Consectetur adipiscing elit.',
    );
    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'city-a', path: cityPath }],
    });
    const hits = await api.search('needle', 5);
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toContain('needle');
  });

  it('falls back to outcome / lede for metadata-only matches', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeFiber(
      join(cityPath, '.felt'),
      'tag-match',
      '---\nname: Some fiber\nstatus: open\ntags:\n  - special-tag\n---\n\nThis is the lede sentence.',
    );
    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'city-a', path: cityPath }],
    });
    const hits = await api.search('special-tag', 5);
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toBe('This is the lede sentence.');
  });

  it('searches across multiple pinned felt hosts', async () => {
    const a = join(TEST_ROOT, 'a');
    const b = join(TEST_ROOT, 'b');
    mkdirSync(join(a, '.felt'), { recursive: true });
    mkdirSync(join(b, '.felt'), { recursive: true });
    writeFiber(join(a, '.felt'), 'fiber-a', '---\nname: Fiber A — needle\nstatus: open\n---\n');
    writeFiber(join(b, '.felt'), 'fiber-b', '---\nname: Fiber B — needle\nstatus: open\n---\n');

    const api = new HttpApiGlobalSearch({
      feltHosts: [a, b],
      cities: [
        { id: 'a', path: a },
        { id: 'b', path: b },
      ],
    });
    const hits = await api.search('needle', 10);
    expect(hits.map((h) => h.id).sort()).toEqual(['fiber-a', 'fiber-b']);
  });

  // ── tree() — Stage 1 ───────────────────────────────────────────────

  it('tree() groups fibers by resolved city, with parent/child structure', async () => {
    const cityPath = join(TEST_ROOT, 'project-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeFiber(join(cityPath, '.felt'), 'top-fiber', '---\nname: Top fiber\nstatus: open\n---\n');
    writeNestedFiber(
      join(cityPath, '.felt'),
      'design/parent',
      '---\nname: Parent\nstatus: active\n---\n\nFirst paragraph of body.',
    );
    writeNestedFiber(
      join(cityPath, '.felt'),
      'design/parent/child',
      '---\nname: Child\nstatus: open\n---\n',
    );

    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'project-a', path: cityPath }],
    });
    const groups = await api.tree();
    expect(groups.length).toBe(1);
    const g = groups[0];
    expect(g.cityId).toBe('project-a');
    expect(g.originId).toBe('local');
    expect(g.isStale).toBe(false);

    // Sorted alphabetically by id; "design/parent" < "design/parent/child" < "top-fiber"
    const ids = g.fibers.map((f) => f.id);
    expect(ids).toEqual(['design/parent', 'design/parent/child', 'top-fiber']);

    const parent = g.fibers.find((f) => f.id === 'design/parent')!;
    expect(parent.parentId).toBe('design');
    expect(parent.hasChildren).toBe(true);
    // No outcome frontmatter, so the lede falls back to the body's first
    // non-empty line — the makeLede contract for the tree view.
    expect(parent.outcome).toBe('First paragraph of body.');

    const child = g.fibers.find((f) => f.id === 'design/parent/child')!;
    expect(child.parentId).toBe('design/parent');
    expect(child.hasChildren).toBe(false);

    const top = g.fibers.find((f) => f.id === 'top-fiber')!;
    expect(top.parentId).toBe(null);
    expect(top.hasChildren).toBe(false);
  });

  it('tree() makes a lede from outcome (preferred) or first body line', async () => {
    const cityPath = join(TEST_ROOT, 'project-a');
    mkdirSync(join(cityPath, '.felt'), { recursive: true });
    writeFiber(
      join(cityPath, '.felt'),
      'with-outcome',
      '---\nname: With outcome\nstatus: open\noutcome: |-\n  Outcome lede line.\n  Second line.\n---\n\nBody first paragraph.',
    );
    writeFiber(
      join(cityPath, '.felt'),
      'body-only',
      '---\nname: Body only\nstatus: open\n---\n\n\nBody first non-empty line.\nSecond.',
    );
    const api = new HttpApiGlobalSearch({
      feltHosts: [cityPath],
      cities: [{ id: 'project-a', path: cityPath }],
    });
    const [g] = await api.tree();
    const withOutcome = g.fibers.find((f) => f.id === 'with-outcome')!;
    const bodyOnly = g.fibers.find((f) => f.id === 'body-only')!;
    expect(withOutcome.outcome).toBe('Outcome lede line.');
    expect(bodyOnly.outcome).toBe('Body first non-empty line.');
  });

  it('tree() flags remote groups as stale when their snapshot is stale', async () => {
    const localPath = join(TEST_ROOT, 'local-only');
    mkdirSync(join(localPath, '.felt'), { recursive: true });
    writeFiber(
      join(localPath, '.felt'),
      'local-fiber',
      '---\nname: Local fiber\nstatus: open\n---\n',
    );

    const remoteFiber = mockFiber('remote-fiber', { name: 'Remote fiber', status: 'active' });
    const staleSnap: FiberTreeSnapshot = {
      originId: 'remote-cineca',
      feltHost: '/home/cd/loom',
      fibers: [remoteFiber],
      byId: new Map([[remoteFiber.id, remoteFiber]]),
      lastFullDump: new Date('2026-04-29T00:00:00Z'),
      status: 'stale',
      staleSince: '2026-04-30T12:00:00Z',
    };

    const api = new HttpApiGlobalSearch({
      feltHosts: [localPath],
      cities: [{ id: 'local-only', path: localPath }],
      remoteSnapshotsProvider: () => [staleSnap],
    });

    const groups = await api.tree();
    expect(groups.length).toBe(2);
    // Local first by ordering rule.
    expect(groups[0].originId).toBe('local');
    expect(groups[0].isStale).toBe(false);

    const remote = groups[1];
    expect(remote.originId).toBe('remote-cineca');
    expect(remote.hostname).toBe('cineca');
    expect(remote.isStale).toBe(true);
    expect(remote.staleSince).toBe('2026-04-30T12:00:00Z');
    expect(remote.fibers.map((f) => f.id)).toEqual(['remote-fiber']);
  });

  it('tree() returns empty array when no fibers exist anywhere', async () => {
    const api = new HttpApiGlobalSearch({
      feltHosts: [join(TEST_ROOT, 'nonexistent')],
    });
    const groups = await api.tree();
    expect(groups).toEqual([]);
  });

  it('tree() collapses unmapped local fibers into a single bucket', async () => {
    // Felt host pinned but not registered as a city — fibers still surface.
    const host = join(TEST_ROOT, 'unscoped-host');
    mkdirSync(join(host, '.felt'), { recursive: true });
    writeFiber(join(host, '.felt'), 'orphan-1', '---\nname: Orphan 1\nstatus: open\n---\n');
    writeFiber(join(host, '.felt'), 'orphan-2', '---\nname: Orphan 2\nstatus: open\n---\n');

    const api = new HttpApiGlobalSearch({
      feltHosts: [host],
      // no cities — nothing resolves
    });
    const groups = await api.tree();
    expect(groups.length).toBe(1);
    expect(groups[0].cityId).toBeUndefined();
    expect(groups[0].originId).toBe('local');
    expect(groups[0].fibers.length).toBe(2);
  });
});
