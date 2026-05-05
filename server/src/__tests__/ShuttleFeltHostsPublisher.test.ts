import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';

import {
  localPinnedFeltHosts,
  publishShuttleFeltHosts,
} from '../ShuttleFeltHostsPublisher.js';
import type { PersistedCity } from '../CityPersistence.js';

function city(path: string, originId: string, id: string): PersistedCity {
  return {
    id,
    path,
    name: id,
    originId,
    position: { q: 0, r: 0 },
    pinnedAt: 0,
  };
}

describe('ShuttleFeltHostsPublisher', () => {
  it('filters to local pinned cities and deduplicates paths', () => {
    expect(localPinnedFeltHosts([
      city('/tmp/loom', 'local', 'loom-a'),
      city('/tmp/project', 'local', 'project'),
      city('/tmp/loom', 'local', 'loom-b'),
      city('/tmp/remote', 'remote-candide', 'remote'),
    ])).toEqual([
      resolve('/tmp/loom'),
      resolve('/tmp/project'),
    ]);
  });

  it('posts the local pinned host list to shuttle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    const result = await publishShuttleFeltHosts([
      city('/tmp/loom', 'local', 'loom'),
      city('/tmp/project', 'local', 'project'),
      city('/tmp/remote', 'remote-candide', 'remote'),
    ], fetchMock as typeof fetch);

    expect(result).toEqual({
      ok: true,
      feltHosts: [resolve('/tmp/loom'), resolve('/tmp/project')],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4000/api/v1/felt-hosts');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      felt_hosts: [resolve('/tmp/loom'), resolve('/tmp/project')],
    });
  });

  it('returns ok=false when shuttle is unavailable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));

    const result = await publishShuttleFeltHosts([
      city('/tmp/loom', 'local', 'loom'),
    ], fetchMock as typeof fetch);

    expect(result).toEqual({ ok: false, feltHosts: [resolve('/tmp/loom')] });
  });
});
