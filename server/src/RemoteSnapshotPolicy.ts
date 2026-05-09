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
      .map((city) => snapshotKey(city.originId, city.path)),
  );

  return snapshots.filter((snapshot) => {
    if (basename(normalizeRemotePath(snapshot.feltHost)) === 'loom') return false;
    return remoteCityKeys.has(snapshotKey(snapshot.originId, snapshot.feltHost));
  });
}

function snapshotKey(originId: string, path: string): string {
  return `${originId}\0${normalizeRemotePath(path)}`;
}

function normalizeRemotePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
