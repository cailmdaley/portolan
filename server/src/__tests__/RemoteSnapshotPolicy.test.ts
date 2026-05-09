import { describe, expect, it } from 'vitest';
import { visibleRemoteSnapshots } from '../RemoteSnapshotPolicy.js';

describe('visibleRemoteSnapshots', () => {
  it('hides remote loom mirror snapshots even when a remote loom city exists', () => {
    const snapshots = [
      { originId: 'remote-candide', feltHost: '/home/cdaley/loom', label: 'stale-loom' },
      { originId: 'remote-candide', feltHost: '/automnt/n17data/cdaley/unions/pure_eb', label: 'project' },
    ];
    const cities = [
      { originId: 'remote-candide', path: '/home/cdaley/loom' },
      { originId: 'remote-candide', path: '/automnt/n17data/cdaley/unions/pure_eb' },
    ];

    expect(visibleRemoteSnapshots(snapshots, cities).map((s) => s.label)).toEqual(['project']);
  });

  it('hides remote snapshots that do not correspond to a known remote city', () => {
    const snapshots = [
      { originId: 'remote-candide', feltHost: '/home/cdaley/projects/stray', label: 'stray' },
      { originId: 'remote-candide', feltHost: '/home/cdaley/projects/pinned', label: 'pinned' },
    ];

    expect(visibleRemoteSnapshots(snapshots, [
      { originId: 'remote-candide', path: '/home/cdaley/projects/pinned/' },
    ]).map((s) => s.label)).toEqual(['pinned']);
  });
});
