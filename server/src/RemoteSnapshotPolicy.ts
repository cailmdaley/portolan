import { basename } from 'path';

export interface RemoteSnapshotRef {
  originId: string;
  feltHost: string;
}

export interface RemoteCityRef {
  originId: string;
  path: string;
}

export function visibleRemoteSnapshots<T extends RemoteSnapshotRef>(
  snapshots: T[],
  cities: RemoteCityRef[],
): T[] {
  const remoteCityKeys = new Set(
    cities
      .filter((city) => city.originId !== 'local')
      .flatMap((city) => visibleRemoteCityPaths(city.originId, cities))
      .map((path) => snapshotKey(path.originId, path.path)),
  );

  return snapshots.filter((snapshot) => {
    if (basename(normalizeRemotePath(snapshot.feltHost)) === 'loom') return false;
    return remoteCityKeys.has(snapshotKey(snapshot.originId, snapshot.feltHost));
  });
}

export function visibleRemoteCityPaths(
  originId: string,
  cities: RemoteCityRef[],
): RemoteCityRef[] {
  const localBasenames = new Set(
    cities
      .filter((city) => city.originId === 'local')
      .map((city) => basename(normalizeRemotePath(city.path))),
  );

  return cities.filter((city) => {
    if (city.originId !== originId) return false;
    const cityBasename = basename(normalizeRemotePath(city.path));
    if (cityBasename === 'loom') return false;
    return !localBasenames.has(cityBasename);
  });
}

function snapshotKey(originId: string, path: string): string {
  return `${originId}\0${normalizeRemotePath(path)}`;
}

function normalizeRemotePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
