import type { GitStatus } from './GitStatusManager.js';
export interface City {
    id: string;
    path: string;
    name: string;
    position: {
        q: number;
        r: number;
    };
    fiberCount?: number;
    hasClaims?: boolean;
    hasPlaygrounds?: boolean;
    gitStatus?: GitStatus;
    createdAt?: number;
    originId: string;
}
export interface SessionInfo {
    cwd: string;
    originId: string;
}
interface OriginPosition {
    q: number;
    r: number;
}
export declare class CityManager {
    private citiesByKey;
    private pinnedCityIds;
    private occupiedWorkerHexes;
    private originPositions;
    private originSshHosts;
    constructor();
    /**
     * Set the sshHost for an origin (used for key normalization)
     * e.g., "remote-login05.leonardo.local" → "cineca-login05"
     */
    setOriginSshHost(originId: string, sshHost: string): void;
    /**
     * Get the base sshHost for an origin (for key normalization)
     */
    private getBaseSshHost;
    /**
     * Set the position for an origin (for remote origins)
     */
    setOriginPosition(originId: string, position: OriginPosition): void;
    /**
     * Get the position for an origin
     */
    getOriginPosition(originId: string): OriginPosition;
    /**
     * Add a persisted (pinned) city. Called on startup with cities from CityPersistence.
     * Position and ID come from persistence, not auto-assigned.
     */
    addPinnedCity(id: string, path: string, name: string, position: {
        q: number;
        r: number;
    }, originId: string): City;
    /**
     * Pin an existing session-derived city or create a new pinned city
     * Returns the city (for CityPersistence to save)
     */
    pinCity(path: string, position: {
        q: number;
        r: number;
    }, originId?: string, name?: string): City;
    /**
     * Unpin a city. If it has no sessions, it will be removed.
     * Returns session count for the city (for warning user).
     */
    unpinCity(cityId: string): {
        removed: boolean;
        sessionCount: number;
    };
    /**
     * Check if a city is pinned
     */
    isPinned(cityId: string): boolean;
    /**
     * Move a city to a new position.
     * Only pinned cities can be moved.
     * Returns the city or null if not found.
     */
    moveCity(cityId: string, newPosition: {
        q: number;
        r: number;
    }): City | null;
    /**
     * Get city by ID
     */
    getCityById(cityId: string): City | null;
    /**
     * Make city key from originId and path.
     * For remote origins with a known sshHost, normalizes the key so different
     * login nodes (e.g., login05, login07) share the same city.
     */
    private makeKey;
    /**
     * Derive cities from a list of sessions.
     * Session-derived cities that no longer have sessions are removed.
     * Pinned cities are preserved regardless of session activity.
     * New session cwds get cities created (using persisted position if pinned).
     * Returns the current set of cities.
     */
    updateFromSessions(sessions: SessionInfo[]): City[];
    /**
     * Get all cities, sorted by name
     */
    getCities(): City[];
    /**
     * Find the city for a given path and origin (exact match)
     */
    findCityForPath(cwd: string, originId?: string): City | null;
    /**
     * Assign a worker hex position for a session in a city.
     * Returns the next available hex in spiral order from city center.
     * First ring (distance 1) = workers 1-6
     * Second ring (distance 2) = workers 7-18
     */
    assignWorkerHex(cityId: string): {
        q: number;
        r: number;
    };
    /**
     * Release a worker hex position when a session ends or moves.
     */
    releaseWorkerHex(cityId: string, hex: {
        q: number;
        r: number;
    }): void;
    /**
     * Auto-assign a hex position by spiraling outward from origin center
     * Enforces minimum 4-tile spacing between city centers within the same origin
     */
    private autoAssignPosition;
    /**
     * Calculate hex distance between two positions
     * Uses axial coordinate system: distance = (|q1-q2| + |q1+r1-q2-r2| + |r1-r2|) / 2
     */
    private hexDistance;
    /**
     * Generate all hex positions in a ring around (centerQ, centerR)
     * Uses cube coordinate system
     */
    private hexRing;
    /**
     * Check if a position is at least minDistance tiles from all existing cities
     */
    private isValidCityPosition;
    /**
     * Detect if a city has claims (workflow/config or results/claims directories)
     * Only works for local cities.
     */
    detectClaims(city: City): boolean;
    /**
     * Update hasClaims for local cities only.
     * Remote cities get hasClaims from agent data, so we don't overwrite.
     */
    updateClaimsStatus(): void;
    /**
     * Detect if a city has playgrounds (.portolan/playgrounds/ with .html files)
     * Only works for local cities.
     */
    detectPlaygrounds(city: City): boolean;
    /**
     * Update hasPlaygrounds for local cities only.
     * Remote cities get hasPlaygrounds from agent data.
     */
    updatePlaygroundsStatus(): void;
}
export {};
//# sourceMappingURL=CityManager.d.ts.map