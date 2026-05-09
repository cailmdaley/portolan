export interface RemoteSnapshotRef {
    originId: string;
    feltHost: string;
}
export interface RemoteCityRef {
    originId: string;
    path: string;
}
export declare function visibleRemoteSnapshots<T extends RemoteSnapshotRef>(snapshots: T[], cities: RemoteCityRef[]): T[];
export declare function visibleRemoteCityPaths(originId: string, cities: RemoteCityRef[]): RemoteCityRef[];
//# sourceMappingURL=RemoteSnapshotPolicy.d.ts.map