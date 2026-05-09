import { basename } from 'path';
export function visibleRemoteSnapshots(snapshots, cities) {
    const remoteCityKeys = new Set(cities
        .filter((city) => city.originId !== 'local')
        .flatMap((city) => visibleRemoteCityPaths(city.originId, cities))
        .map((path) => snapshotKey(path.originId, path.path)));
    return snapshots.filter((snapshot) => {
        if (basename(normalizeRemotePath(snapshot.feltHost)) === 'loom')
            return false;
        return remoteCityKeys.has(snapshotKey(snapshot.originId, snapshot.feltHost));
    });
}
export function visibleRemoteCityPaths(originId, cities) {
    const localBasenames = new Set(cities
        .filter((city) => city.originId === 'local')
        .map((city) => basename(normalizeRemotePath(city.path))));
    return cities.filter((city) => {
        if (city.originId !== originId)
            return false;
        const cityBasename = basename(normalizeRemotePath(city.path));
        if (cityBasename === 'loom')
            return false;
        return !localBasenames.has(cityBasename);
    });
}
function snapshotKey(originId, path) {
    return `${originId}\0${normalizeRemotePath(path)}`;
}
function normalizeRemotePath(path) {
    return path.replace(/\/+$/, '') || '/';
}
//# sourceMappingURL=RemoteSnapshotPolicy.js.map