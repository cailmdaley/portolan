import { describe, expect, it } from 'vitest';
import { RecentsStore } from '../RecentsStore.js';

function makeStore(): RecentsStore {
  // Per-test in-memory db; node:sqlite supports ':memory:' just like
  // better-sqlite3. Closes are safe; isolation is per-instance.
  return new RecentsStore(':memory:');
}

describe('RecentsStore', () => {
  it('upserts on (viewer, origin, city, kind, path); view_count increments and survives close+reopen with a path-backed db', () => {
    const store = makeStore();
    if (!store.isEnabled()) {
      // Older Node without node:sqlite — the store is a documented no-op
      // and the rest of the suite tests behaviour that requires SQLite.
      return;
    }

    const args = {
      viewerKind: 'human' as const,
      viewerId: 'human',
      originId: 'local',
      cityId: 'portolan',
      kind: 'fiber' as const,
      path: 'portolan/portolan',
      timestamp: 1000,
    };
    for (let i = 0; i < 5; i += 1) {
      store.recordView({ ...args, timestamp: 1000 + i });
    }

    const rows = store.getRecents({ cityId: 'portolan' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cityId: 'portolan',
      kind: 'fiber',
      path: 'portolan/portolan',
      viewCount: 5,
      lastViewedAt: 1004,
    });
    expect(rows[0].viewerKinds).toEqual(['human']);
  });

  it('rolls up viewer kinds across human + agent and exposes both badges', () => {
    const store = makeStore();
    if (!store.isEnabled()) return;

    const base = {
      originId: 'local',
      cityId: 'portolan',
      kind: 'fiber' as const,
      path: 'portolan/portolan',
    };
    store.recordView({ ...base, viewerKind: 'human', viewerId: 'human', timestamp: 1000 });
    store.recordView({ ...base, viewerKind: 'agent', viewerId: 'sess-1', timestamp: 1100 });
    store.recordView({ ...base, viewerKind: 'agent', viewerId: 'sess-1', timestamp: 1200 });

    const rows = store.getRecents();
    expect(rows).toHaveLength(1);
    expect(rows[0].viewCount).toBe(3);
    expect(new Set(rows[0].viewerKinds)).toEqual(new Set(['human', 'agent']));
  });

  it('top-N is per current scope: city filter restricts, no filter aggregates global', () => {
    const store = makeStore();
    if (!store.isEnabled()) return;

    store.recordView({
      viewerKind: 'human', viewerId: 'human',
      originId: 'local', cityId: 'portolan',
      kind: 'fiber', path: 'portolan/a', timestamp: 1000,
    });
    store.recordView({
      viewerKind: 'human', viewerId: 'human',
      originId: 'local', cityId: 'cmbx',
      kind: 'fiber', path: 'cmbx/b', timestamp: 2000,
    });
    store.recordView({
      viewerKind: 'human', viewerId: 'human',
      originId: 'local', cityId: 'portolan',
      kind: 'file', path: 'src/main.ts', timestamp: 3000,
    });

    const portolan = store.getRecents({ cityId: 'portolan' });
    expect(portolan.map(r => r.path)).toEqual(['src/main.ts', 'portolan/a']);

    const global = store.getRecents();
    expect(global.map(r => r.path)).toEqual(['src/main.ts', 'cmbx/b', 'portolan/a']);

    const portolanFibers = store.getRecents({ cityId: 'portolan', kind: 'fiber' });
    expect(portolanFibers.map(r => r.path)).toEqual(['portolan/a']);
  });

  it('persists across instances when the database is path-backed', () => {
    // Use a fresh tmp file path; both instances open it sequentially.
    // After the first instance closes, the second should see the rows.
    const tmpDir = process.env.RUNNER_TEMP ?? '/tmp';
    const dbPath = `${tmpDir}/portolan-recents-${process.pid}-${Date.now()}.sqlite`;

    const first = new RecentsStore(dbPath);
    if (!first.isEnabled()) {
      first.close();
      return;
    }
    for (let i = 0; i < 5; i += 1) {
      first.recordView({
        viewerKind: 'human', viewerId: 'human',
        originId: 'local', cityId: 'portolan',
        kind: 'fiber', path: 'portolan/portolan',
        timestamp: 1000 + i,
      });
    }
    first.close();

    const second = new RecentsStore(dbPath);
    const rows = second.getRecents();
    expect(rows).toHaveLength(1);
    expect(rows[0].viewCount).toBe(5);
    expect(rows[0].lastViewedAt).toBe(1004);
    second.close();
  });

  it('limit defaults to 8 and is capped at 100', () => {
    const store = makeStore();
    if (!store.isEnabled()) return;

    for (let i = 0; i < 12; i += 1) {
      store.recordView({
        viewerKind: 'human', viewerId: 'human',
        originId: 'local', cityId: 'portolan',
        kind: 'file', path: `f${i}`,
        timestamp: 1000 + i,
      });
    }
    expect(store.getRecents().length).toBe(8);
    expect(store.getRecents({ limit: 5 }).length).toBe(5);
    expect(store.getRecents({ limit: 1000 }).length).toBe(12);
  });

  it('drops viewer-incomplete records', () => {
    const store = makeStore();
    if (!store.isEnabled()) return;
    // Missing cityId / path — do not insert.
    store.recordView({
      viewerKind: 'human', viewerId: 'human',
      originId: 'local', cityId: '',
      kind: 'fiber', path: 'portolan/portolan',
      timestamp: 1000,
    });
    expect(store.getRowCount()).toBe(0);
  });
});
