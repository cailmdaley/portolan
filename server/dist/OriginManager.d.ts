/**
 * OriginManager - Track connected origins (local + remote machines)
 *
 * Origins are remote machines connected via SSH tunnel.
 * Each origin gets a compass position offset for its cities.
 */
import { WebSocket } from 'ws';
export interface Origin {
    id: string;
    name: string;
    type: 'local' | 'remote';
    sshHost?: string;
    position: {
        q: number;
        r: number;
    };
    connectedAt: number;
    lastSeen: number;
    agentSockets: Set<WebSocket>;
}
export declare class OriginManager {
    private origins;
    private socketToOrigin;
    private nextPositionIndex;
    constructor();
    /**
     * Register or reconnect an origin when an agent connects.
     * Returns the origin object.
     */
    registerAgent(originName: string, ws: WebSocket, sshHost?: string): Origin;
    /**
     * Handle agent disconnection
     */
    handleDisconnect(ws: WebSocket): Origin | null;
    /**
     * Get origin by ID
     */
    getOrigin(originId: string): Origin | null;
    /**
     * Get origin for a WebSocket
     */
    getOriginForSocket(ws: WebSocket): Origin | null;
    /**
     * Get origin ID for a WebSocket
     */
    getOriginIdForSocket(ws: WebSocket): string | null;
    /**
     * Get all origins
     */
    getOrigins(): Origin[];
    /**
     * Check if origin is connected (has at least one agent socket)
     */
    isOriginConnected(originId: string): boolean;
    /**
     * Get compass position for an origin index.
     * Origins placed at cardinal/intercardinal directions.
     * Distance is 6 hex radii - close enough to be on same map, far enough for separation.
     */
    private getCompassPosition;
}
//# sourceMappingURL=OriginManager.d.ts.map