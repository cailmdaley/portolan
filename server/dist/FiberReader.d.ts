export interface Fiber {
    id: string;
    title: string;
    status: string;
    kind: string;
    priority: number;
    createdAt: string;
    body?: string;
    reason?: string;
    closedAt?: string;
}
/**
 * Counts open fibers for a city by reading its .felt/ directory.
 *
 * @param cityPath Absolute path to the city directory
 * @returns Number of fibers with status !== 'closed'
 */
export declare function countOpenFibers(cityPath: string): Promise<number>;
/**
 * Gets all open fibers for a city.
 *
 * @param cityPath Absolute path to the city directory
 * @returns Array of fibers with status !== 'closed', sorted by active first, then by priority
 */
export declare function getOpenFibers(cityPath: string): Promise<Fiber[]>;
/**
 * Gets recently closed fibers for a city.
 *
 * @param cityPath Absolute path to the city directory
 * @param limit Maximum number of fibers to return
 * @returns Array of closed fibers sorted by closed date descending
 */
export declare function getRecentlyClosed(cityPath: string, limit: number): Promise<Fiber[]>;
//# sourceMappingURL=FiberReader.d.ts.map