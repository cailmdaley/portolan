export interface Fiber {
    id: string;
    name: string;
    status: string;
    kind: string;
    priority: number;
    createdAt: string;
    body?: string;
    outcome?: string;
    closedAt?: string;
    tags?: string[];
    dependsOn?: string[];
    parentId?: string | null;
    isRoot?: boolean;
}
/**
 * Counts open fibers for a city by reading its .felt/ directory.
 */
export declare function countOpenFibers(cityPath: string): Promise<number>;
/**
 * Gets all open fibers for a city.
 * Returns fibers with status !== 'closed', sorted by active first, then by priority.
 */
export declare function getOpenFibers(cityPath: string): Promise<Fiber[]>;
/**
 * Gets recently closed fibers for a city.
 */
export declare function getRecentlyClosed(cityPath: string, limit: number): Promise<Fiber[]>;
/**
 * Gets all fibers (any status) matching a tag prefix.
 */
export declare function getFibersByTag(cityPath: string, tagPrefix: string): Promise<Fiber[]>;
/**
 * Gets all fibers for a city regardless of status.
 */
export declare function getAllFibers(cityPath: string): Promise<Fiber[]>;
/**
 * Parse a fiber file into a Fiber object.
 *
 * @param id The fiber ID (slug, e.g., "my-fiber")
 * @param content File content with YAML frontmatter
 */
export declare function parseFiber(id: string, content: string): Fiber;
//# sourceMappingURL=FiberReader.d.ts.map