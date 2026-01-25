/**
 * OriginManager - Track connected origins (local + remote machines)
 *
 * Origins are remote machines connected via SSH tunnel.
 * Each origin gets a compass position offset for its cities.
 */
import { hostname } from 'os';
// ============================================================================
// OriginManager
// ============================================================================
export class OriginManager {
    origins = new Map();
    socketToOrigin = new Map();
    nextPositionIndex = 0;
    constructor() {
        // Initialize local origin at center
        this.origins.set('local', {
            id: 'local',
            name: hostname(),
            type: 'local',
            position: { q: 0, r: 0 },
            connectedAt: Date.now(),
            lastSeen: Date.now(),
            agentSockets: new Set(),
        });
    }
    /**
     * Register or reconnect an origin when an agent connects.
     * Returns the origin object.
     */
    registerAgent(originName, ws, sshHost, plannotatorPort) {
        const originId = `remote-${originName}`;
        let origin = this.origins.get(originId);
        if (!origin) {
            // New origin - assign compass position
            this.nextPositionIndex++;
            origin = {
                id: originId,
                name: originName,
                type: 'remote',
                sshHost: sshHost || originName,
                plannotatorPort,
                position: this.getCompassPosition(this.nextPositionIndex),
                connectedAt: Date.now(),
                lastSeen: Date.now(),
                agentSockets: new Set(),
            };
            this.origins.set(originId, origin);
            console.log(`New origin connected: ${originName} at position (${origin.position.q}, ${origin.position.r})${plannotatorPort ? ` plannotator:${plannotatorPort}` : ''}`);
        }
        else {
            // Existing origin - update lastSeen
            origin.lastSeen = Date.now();
            if (sshHost) {
                origin.sshHost = sshHost;
            }
            if (plannotatorPort) {
                origin.plannotatorPort = plannotatorPort;
            }
            console.log(`Origin reconnected: ${originName}`);
        }
        // Track this WebSocket → origin mapping
        origin.agentSockets.add(ws);
        this.socketToOrigin.set(ws, originId);
        return origin;
    }
    /**
     * Handle agent disconnection
     */
    handleDisconnect(ws) {
        const originId = this.socketToOrigin.get(ws);
        this.socketToOrigin.delete(ws);
        if (!originId || originId === 'local')
            return null;
        const origin = this.origins.get(originId);
        if (!origin)
            return null;
        origin.agentSockets.delete(ws);
        // If no more sockets for this origin, it's fully disconnected
        if (origin.agentSockets.size === 0) {
            console.log(`Origin fully disconnected: ${origin.name}`);
            return origin;
        }
        return null; // Still has other connections
    }
    /**
     * Get origin by ID
     */
    getOrigin(originId) {
        return this.origins.get(originId) || null;
    }
    /**
     * Get all origins
     */
    getOrigins() {
        return Array.from(this.origins.values());
    }
    /**
     * Check if origin is connected (has at least one agent socket)
     */
    isOriginConnected(originId) {
        const origin = this.origins.get(originId);
        if (!origin)
            return false;
        if (origin.type === 'local')
            return true;
        return origin.agentSockets.size > 0;
    }
    /**
     * Set plannotator port for local origin
     */
    setLocalPlannotatorPort(port) {
        const local = this.origins.get('local');
        if (local) {
            local.plannotatorPort = port;
        }
    }
    /**
     * Get compass position for an origin index.
     * Origins placed at cardinal/intercardinal directions.
     * Distance is 6 hex radii - close enough to be on same map, far enough for separation.
     */
    getCompassPosition(index) {
        const distance = 6; // Hex radii from center (min spacing between civilizations)
        // Compass positions in axial coordinates
        // Note: in pointy-top hex grid, directions are:
        // E  = (+distance, 0)
        // SE = (+distance/2, +distance)  ~= (10, 17) for d=20
        // SW = (-distance/2, +distance)  ~= (-10, 17)
        // W  = (-distance, 0)
        // NW = (-distance/2, -distance)
        // NE = (+distance/2, -distance)
        const positions = [
            { q: distance, r: 0 }, // E
            { q: 0, r: distance }, // S (actually SE in pointy-top)
            { q: -distance, r: 0 }, // W
            { q: 0, r: -distance }, // N (actually NW in pointy-top)
            { q: distance, r: -distance }, // NE
            { q: -distance, r: distance }, // SW
            { q: distance, r: distance }, // SE (far)
            { q: -distance, r: -distance }, // NW (far)
        ];
        return positions[(index - 1) % positions.length];
    }
}
//# sourceMappingURL=OriginManager.js.map