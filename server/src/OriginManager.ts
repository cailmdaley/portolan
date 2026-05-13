/**
 * OriginManager - Track connected origins (local + remote machines)
 *
 * Origins are remote machines connected via SSH tunnel.
 * Each origin gets a compass position offset for its cities.
 */

import { hostname } from 'os';
import { WebSocket } from 'ws';

// ============================================================================
// Types
// ============================================================================

export interface Origin {
  id: string;                    // 'local' | 'remote-{hostname}'
  name: string;                  // hostname
  type: 'local' | 'remote';
  sshHost?: string;              // SSH config host (for remote focus)
  agentRuntime?: RemoteAgentRuntime; // Runtime that currently owns this origin socket
  agentOnce?: boolean;           // One-shot Rust agents intentionally do not auto-recover
  plannotatorPort?: number;      // Port for plannotator on this origin
  position: { q: number; r: number };  // hex offset for this origin's cities
  connectedAt: number;
  lastSeen: number;
  agentSockets: Set<WebSocket>;  // all agent connections for this origin
}

export type RemoteAgentRuntime = 'node' | 'rust';

// ============================================================================
// OriginManager
// ============================================================================

export class OriginManager {
  private origins = new Map<string, Origin>();
  private socketToOrigin = new Map<WebSocket, string>();
  private nextPositionIndex = 0;

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
  registerAgent(
    originName: string,
    ws: WebSocket,
    sshHost?: string,
    plannotatorPort?: number,
    agentRuntime: RemoteAgentRuntime = 'node',
    agentOnce = false,
  ): Origin {
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
        agentRuntime,
        agentOnce,
        plannotatorPort,
        position: this.getCompassPosition(this.nextPositionIndex),
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        agentSockets: new Set(),
      };
      this.origins.set(originId, origin);
      console.log(`New origin connected: ${originName} at position (${origin.position.q}, ${origin.position.r})${plannotatorPort ? ` plannotator:${plannotatorPort}` : ''}`);
    } else {
      // Existing origin - update lastSeen
      origin.lastSeen = Date.now();
      if (sshHost) {
        origin.sshHost = sshHost;
      }
      origin.agentRuntime = agentRuntime;
      origin.agentOnce = agentOnce;
      if (plannotatorPort) {
        origin.plannotatorPort = plannotatorPort;
      }
      console.log(`Origin reconnected: ${originName}`);
    }

    // Keep at most one live agent socket per remote origin.
    // If a new agent connects while an old one is still around, prefer the new connection
    // so stale agents cannot race and overwrite the same origin state.
    for (const existingSocket of origin.agentSockets) {
      if (existingSocket === ws) continue;
      this.socketToOrigin.delete(existingSocket);
      try {
        existingSocket.close();
      } catch {
        // Ignore close errors from half-dead sockets.
      }
    }
    origin.agentSockets.clear();

    // Track this WebSocket → origin mapping
    origin.agentSockets.add(ws);
    this.socketToOrigin.set(ws, originId);

    return origin;
  }

  /**
   * Handle agent disconnection
   */
  handleDisconnect(ws: WebSocket): Origin | null {
    const originId = this.socketToOrigin.get(ws);
    this.socketToOrigin.delete(ws);

    if (!originId || originId === 'local') return null;

    const origin = this.origins.get(originId);
    if (!origin) return null;

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
  getOrigin(originId: string): Origin | null {
    return this.origins.get(originId) || null;
  }

  /**
   * Get all origins
   */
  getOrigins(): Origin[] {
    return Array.from(this.origins.values());
  }

  /**
   * Check if origin is connected (has at least one agent socket)
   */
  isOriginConnected(originId: string): boolean {
    const origin = this.origins.get(originId);
    if (!origin) return false;
    if (origin.type === 'local') return true;
    return origin.agentSockets.size > 0;
  }

  /**
   * Set plannotator port for local origin
   */
  setLocalPlannotatorPort(port: number): void {
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
  private getCompassPosition(index: number): { q: number; r: number } {
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
      { q: distance, r: 0 },           // E
      { q: 0, r: distance },           // S (actually SE in pointy-top)
      { q: -distance, r: 0 },          // W
      { q: 0, r: -distance },          // N (actually NW in pointy-top)
      { q: distance, r: -distance },   // NE
      { q: -distance, r: distance },   // SW
      { q: distance, r: distance },    // SE (far)
      { q: -distance, r: -distance },  // NW (far)
    ];

    return positions[(index - 1) % positions.length];
  }
}
