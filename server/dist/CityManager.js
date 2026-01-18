/**
 * CityManager - Derive cities from active sessions
 *
 * Cities are ephemeral — they exist while ≥1 session has that cwd.
 * No persistence. Cities come and go with sessions.
 *
 * Each city has:
 * - A filesystem path (unique per origin)
 * - An originId (local or remote-{hostname})
 * - A hex grid position (q, r) — offset by origin's compass position
 * - A display name
 */
import { resolve, basename } from 'path';
import { randomUUID } from 'crypto';
// ============================================================================
// CityManager
// ============================================================================
export class CityManager {
    // In-memory only: key → city (key = `${originId}:${path}`)
    citiesByKey = new Map();
    // Track occupied worker hexes per city: Map<cityId, Set<hexKey>>
    occupiedWorkerHexes = new Map();
    // Track origin positions: Map<originId, position>
    originPositions = new Map();
    constructor() {
        // Local origin is always at center
        this.originPositions.set('local', { q: 0, r: 0 });
    }
    /**
     * Set the position for an origin (for remote origins)
     */
    setOriginPosition(originId, position) {
        this.originPositions.set(originId, position);
    }
    /**
     * Get the position for an origin
     */
    getOriginPosition(originId) {
        return this.originPositions.get(originId) || { q: 0, r: 0 };
    }
    /**
     * Make city key from originId and path
     */
    makeKey(originId, path) {
        return `${originId}:${resolve(path)}`;
    }
    /**
     * Derive cities from a list of sessions.
     * Cities that no longer have sessions are removed.
     * New session cwds get cities created.
     * Returns the current set of cities.
     */
    updateFromSessions(sessions) {
        // Build set of active keys
        const activeKeys = new Set();
        for (const session of sessions) {
            const key = this.makeKey(session.originId, session.cwd);
            activeKeys.add(key);
        }
        // Remove cities that no longer have sessions
        for (const [key, city] of this.citiesByKey) {
            if (!activeKeys.has(key)) {
                this.citiesByKey.delete(key);
                this.occupiedWorkerHexes.delete(city.id);
            }
        }
        // Add cities for new session cwds
        for (const session of sessions) {
            const key = this.makeKey(session.originId, session.cwd);
            if (!this.citiesByKey.has(key)) {
                const originPos = this.getOriginPosition(session.originId);
                const city = {
                    id: randomUUID(),
                    path: resolve(session.cwd),
                    name: basename(session.cwd),
                    position: this.autoAssignPosition(originPos, session.originId),
                    originId: session.originId,
                };
                this.citiesByKey.set(key, city);
            }
        }
        return this.getCities();
    }
    /**
     * Get all cities, sorted by name
     */
    getCities() {
        return [...this.citiesByKey.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    /**
     * Find the city for a given path and origin (exact match)
     */
    findCityForPath(cwd, originId = 'local') {
        const key = this.makeKey(originId, cwd);
        return this.citiesByKey.get(key) || null;
    }
    /**
     * Assign a worker hex position for a session in a city.
     * Returns the next available hex in spiral order from city center.
     * First ring (distance 1) = workers 1-6
     * Second ring (distance 2) = workers 7-18
     */
    assignWorkerHex(cityId) {
        // Ensure we have a set for this city
        if (!this.occupiedWorkerHexes.has(cityId)) {
            this.occupiedWorkerHexes.set(cityId, new Set());
        }
        const occupied = this.occupiedWorkerHexes.get(cityId);
        // Spiral outward from city center to find first unoccupied hex
        // Start at ring 1 (workers around the city center)
        for (let ring = 1; ring < 10; ring++) {
            const positions = this.hexRing(0, 0, ring);
            for (const pos of positions) {
                const key = `${pos.q},${pos.r}`;
                if (!occupied.has(key)) {
                    // Mark as occupied
                    occupied.add(key);
                    return pos;
                }
            }
        }
        // Fallback (should never reach here with reasonable worker counts)
        return { q: 1, r: 0 };
    }
    /**
     * Release a worker hex position when a session ends or moves.
     */
    releaseWorkerHex(cityId, hex) {
        if (!this.occupiedWorkerHexes.has(cityId)) {
            return;
        }
        const occupied = this.occupiedWorkerHexes.get(cityId);
        const key = `${hex.q},${hex.r}`;
        occupied.delete(key);
    }
    /**
     * Auto-assign a hex position by spiraling outward from origin center
     * Enforces minimum 3-tile spacing between city centers within the same origin
     */
    autoAssignPosition(originPos, originId) {
        // Get cities for this origin only (cities from other origins don't constrain positioning)
        const originCities = this.getCities().filter(c => c.originId === originId);
        // Try origin center first (always valid for first city in this origin)
        const center = { q: originPos.q, r: originPos.r };
        if (this.isValidCityPosition(center, originCities, 3)) {
            return center;
        }
        // Spiral outward from origin center, checking both occupancy and minimum spacing
        for (let ring = 1; ring < 100; ring++) {
            const positions = this.hexRing(originPos.q, originPos.r, ring);
            for (const pos of positions) {
                if (this.isValidCityPosition(pos, originCities, 3)) {
                    return pos;
                }
            }
        }
        // Fallback (should never reach here)
        return center;
    }
    /**
     * Calculate hex distance between two positions
     * Uses axial coordinate system: distance = (|q1-q2| + |q1+r1-q2-r2| + |r1-r2|) / 2
     */
    hexDistance(a, b) {
        return (Math.abs(a.q - b.q) +
            Math.abs(a.q + a.r - b.q - b.r) +
            Math.abs(a.r - b.r)) / 2;
    }
    /**
     * Generate all hex positions in a ring around (centerQ, centerR)
     * Uses cube coordinate system
     */
    hexRing(centerQ, centerR, radius) {
        if (radius === 0) {
            return [{ q: centerQ, r: centerR }];
        }
        const positions = [];
        // Hex directions in axial (q, r) coordinates
        const directions = [
            { q: 1, r: 0 }, // E
            { q: 1, r: -1 }, // NE
            { q: 0, r: -1 }, // NW
            { q: -1, r: 0 }, // W
            { q: -1, r: 1 }, // SW
            { q: 0, r: 1 }, // SE
        ];
        // Start at radius steps in one direction
        let q = centerQ - radius;
        let r = centerR + radius;
        // Walk around the ring
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < radius; j++) {
                positions.push({ q, r });
                q += directions[i].q;
                r += directions[i].r;
            }
        }
        return positions;
    }
    /**
     * Check if a position is at least minDistance tiles from all existing cities
     */
    isValidCityPosition(position, cities, minDistance) {
        for (const city of cities) {
            if (this.hexDistance(position, city.position) < minDistance) {
                return false;
            }
        }
        return true;
    }
}
//# sourceMappingURL=CityManager.js.map