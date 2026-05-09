import { basename } from 'path';
export function visibleRemoteSnapshots(snapshots, cities) {
    const remoteCityKeys = new Set(cities
        .filter((city) => city.originId !== 'local')
        .map((city) => snapshotKey(city.originId, city.path)));
    return snapshots.filter((snapshot) => {
        if (basename(normalizeRemotePath(snapshot.feltHost)) === 'loom')
            return false;
        return remoteCityKeys.has(snapshotKey(snapshot.originId, snapshot.feltHost));
    });
}
function snapshotKey(originId, path) {
    return `${originId}\0${normalizeRemotePath(path)}`;
}
function normalizeRemotePath(path) {
    return path.replace(/\/+$/, '') || '/';
}
//# sourceMappingURL=RemoteSnapshotPolicy.js.map