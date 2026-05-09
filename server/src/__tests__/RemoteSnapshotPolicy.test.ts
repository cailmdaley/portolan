import { describe, expect, it } from 'vitest';
import { visibleRemoteCityPaths, visibleRemoteSnapshots } from '../RemoteSnapshotPolicy.js';

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

  it('hides remote project mirrors when the same project is pinned locally', () => {
    const snapshots = [
      { originId: 'remote-candide', feltHost: '/home/cdaley/projects/ai-futures', label: 'stale-mirror' },
      { originId: 'remote-candide', feltHost: '/automnt/n17data/cdaley/unions/pure_eb', label: 'remote-only' },
    ];
    const cities = [
      { originId: 'local', path: '/Users/cd280747/Documents/projects/ai-futures' },
      { originId: 'remote-candide', path: '/home/cdaley/projects/ai-futures' },
      { originId: 'remote-candide', path: '/automnt/n17data/cdaley/unions/pure_eb' },
    ];

    expect(visibleRemoteSnapshots(snapshots, cities).map((s) => s.label)).toEqual(['remote-only']);
  });
});

describe('visibleRemoteCityPaths', () => {
  it('uses the same mirror policy for agent-published felt hosts', () => {
    const cities = [
      { originId: 'local', path: '/Users/cd280747/Documents/projects/ai-futures' },
      { originId: 'remote-candide', path: '/home/cdaley/loom' },
      { originId: 'remote-candide', path: '/home/cdaley/projects/ai-futures' },
      { originId: 'remote-candide', path: '/automnt/n17data/cdaley/unions/pure_eb' },
    ];

    expect(visibleRemoteCityPaths('remote-candide', cities).map((city) => city.path)).toEqual([
      '/automnt/n17data/cdaley/unions/pure_eb',
    ]);
  });
});
