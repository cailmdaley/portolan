/**
 * Unit tests for FiberTreeSnapshotStore.
 *
 * Stage 3a of [[ai-futures/portolan/vellum-reader/constitution-vellum-kanban]].
 *
 * Covers the wire-format → in-memory `Fiber[]` translation and lifecycle:
 * full dumps replace wholesale, deltas mutate in place, stale/fresh
 * flipping behaves, and non-container .md files are skipped silently.
 */

import { describe, it, expect } from 'vitest';
import { FiberTreeSnapshotStore, idFromPath } from '../FiberTreeSnapshotStore.js';

const baseFm = (extras: Record<string, string> = {}) => {
  const fields: Record<string, string> = {
    name: 'A fiber',
    status: 'active',
    'created-at': '2026-04-15T00:00:00Z',
    ...extras,
  };
  const lines = [
    'tags:',
    '  - constitution',
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
  ];
  return `---\n${lines.join('\n')}\n---\n\nbody\n`;
};

describe('FiberTreeSnapshotStore', () => {
  describe('idFromPath', () => {
    it('resolves entry-point fibers (single-segment .md at root)', () => {
      expect(idFromPath('cmbx.md')).toEqual({
        id: 'cmbx',
        isRoot: true,
        parentId: null,
      });
    });

    it('resolves directory-shaped fibers (dir/dir.md)', () => {
      expect(idFromPath('cmbx/cmbx.md')).toEqual({
        id: 'cmbx',
        isRoot: false,
        parentId: null,
      });
    });

    it('resolves nested container fibers (parent/dir/dir.md)', () => {
      expect(idFromPath('ai-futures/portolan/portolan.md')).toEqual({
        id: 'ai-futures/portolan',
        isRoot: false,
        parentId: 'ai-futures',
      });
    });

    it('returns null for non-container .md files (sibling md inside a dir)', () => {
      expect(idFromPath('cmbx/notes.md')).toBeNull();
      expect(idFromPath('ai-futures/portolan/random.md')).toBeNull();
    });

    it('returns null for non-md files', () => {
      expect(idFromPath('cmbx/cmbx.txt')).toBeNull();
      expect(idFromPath('cmbx/data.json')).toBeNull();
    });

    it('strips a leading ./', () => {
      expect(idFromPath('./cmbx.md')?.id).toBe('cmbx');
    });
  });

  describe('upsertFullDump', () => {
    it('replaces the snapshot wholesale and skips non-container files', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm() },
        { path: 'cmbx/notes.md', content: '# stray markdown' },
        { path: 'pure_eb/pure_eb.md', content: baseFm() },
      ]);
      const snap = store.getSnapshot('remote-cineca');
      expect(snap).not.toBeNull();
      expect(snap!.fibers.map(f => f.id).sort()).toEqual(['cmbx', 'pure_eb']);
      expect(snap!.byId.get('cmbx')?.tags).toContain('constitution');
      expect(snap!.status).toBe('fresh');
      expect(snap!.feltHost).toBe('/leonardo/loom');
    });

    it('a second dump replaces; previously-present fibers vanish', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm() },
        { path: 'pure_eb/pure_eb.md', content: baseFm() },
      ]);
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm() },
      ]);
      expect(store.getSnapshot('remote-cineca')!.fibers.map(f => f.id)).toEqual(['cmbx']);
    });
  });

  describe('applyDelta', () => {
    it('upsert mutates a fiber in place', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm({ status: 'active' }) },
      ]);
      store.applyDelta('remote-cineca', [
        { path: 'cmbx/cmbx.md', op: 'upsert', content: baseFm({ status: 'closed' }) },
      ]);
      expect(store.getSnapshot('remote-cineca')!.byId.get('cmbx')?.status).toBe('closed');
    });

    it('upsert adds a fiber that didn’t exist', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', []);
      store.applyDelta('remote-cineca', [
        { path: 'cmbx/cmbx.md', op: 'upsert', content: baseFm() },
      ]);
      expect(store.getSnapshot('remote-cineca')!.byId.has('cmbx')).toBe(true);
    });

    it('delete removes a fiber', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm() },
        { path: 'pure_eb/pure_eb.md', content: baseFm() },
      ]);
      store.applyDelta('remote-cineca', [
        { path: 'cmbx/cmbx.md', op: 'delete' },
      ]);
      expect(store.getSnapshot('remote-cineca')!.byId.has('cmbx')).toBe(false);
      expect(store.getSnapshot('remote-cineca')!.byId.has('pure_eb')).toBe(true);
    });

    it('skips deltas for paths that don’t resolve to fibers', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', []);
      store.applyDelta('remote-cineca', [
        { path: 'cmbx/notes.md', op: 'upsert', content: 'stray' },
        { path: 'cmbx/cmbx.md', op: 'upsert', content: baseFm() },
      ]);
      expect(store.getSnapshot('remote-cineca')!.fibers.map(f => f.id)).toEqual(['cmbx']);
    });

    it('drops a delta batch if no snapshot exists yet', () => {
      const store = new FiberTreeSnapshotStore();
      store.applyDelta('remote-cineca', [
        { path: 'cmbx/cmbx.md', op: 'upsert', content: baseFm() },
      ]);
      expect(store.getSnapshot('remote-cineca')).toBeNull();
    });

    it('a delta after staleness flips back to fresh', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm() },
      ]);
      store.markStale('remote-cineca', '2026-04-29T00:00:00Z');
      expect(store.getSnapshot('remote-cineca')!.status).toBe('stale');
      store.applyDelta('remote-cineca', [
        { path: 'cmbx/cmbx.md', op: 'upsert', content: baseFm() },
      ]);
      expect(store.getSnapshot('remote-cineca')!.status).toBe('fresh');
      expect(store.getSnapshot('remote-cineca')!.staleSince).toBeUndefined();
    });
  });

  describe('staleness', () => {
    it('markStale flips status, snapshot is preserved', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm() },
      ]);
      store.markStale('remote-cineca', '2026-04-29T00:00:00Z');
      const snap = store.getSnapshot('remote-cineca');
      expect(snap?.status).toBe('stale');
      expect(snap?.staleSince).toBe('2026-04-29T00:00:00Z');
      // Cards are still readable while stale.
      expect(snap?.fibers.map(f => f.id)).toEqual(['cmbx']);
    });

    it('markFresh clears the staleSince timestamp', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', []);
      store.markStale('remote-cineca', '2026-04-29T00:00:00Z');
      store.markFresh('remote-cineca');
      const snap = store.getSnapshot('remote-cineca');
      expect(snap?.status).toBe('fresh');
      expect(snap?.staleSince).toBeUndefined();
    });
  });

  describe('getAllSnapshots', () => {
    it('returns every origin’s snapshot', () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: baseFm() },
      ]);
      store.upsertFullDump('remote-candide', '/automnt/candide/loom', [
        { path: 'pure_eb/pure_eb.md', content: baseFm() },
      ]);
      const all = store.getAllSnapshots();
      expect(all.map(s => s.originId).sort()).toEqual(['remote-candide', 'remote-cineca']);
    });
  });
});
