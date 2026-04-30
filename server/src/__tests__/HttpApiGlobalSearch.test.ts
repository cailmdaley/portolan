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
import { writeFiber } from './test-utils.js';
import { parseFiber } from '../FiberReader.js';

/** Like writeFiber but supports nested slugs (e.g. `design/foo` → `design/foo/foo.md`). */
function writeNestedFiber(feltDir: string, slug: string, content: string): void {
  const dir = join(feltDir, slug);
  const basename = slug.split('/').pop()!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename}.md`), content, 'utf-8');
}

const TEST_ROOT = join(homedir(), '.portolan-test-global-search');

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

    const remoteOnly = parseFiber('remote-only', '---\nname: Remote only\nstatus: open\n---\n');
    const collidingId = parseFiber(
      'local-only',
      '---\nname: Stale remote mirror\nstatus: closed\n---\n',
    );
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
});
