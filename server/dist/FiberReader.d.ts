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
    tempered?: boolean;
    /** True when the fiber has a `shuttle:` frontmatter block. The dispatch signal lives here. */
    hasShuttleBlock?: boolean;
    /**
     * Whether shuttle dispatch is enabled for this fiber (`shuttle.enabled`).
     * Present only when `hasShuttleBlock` is true. `false` means the fiber is
     * in the drafts column (installed but paused); `true` means in-flight
     * (eligible for dispatch). Absence means the fiber has no shuttle block.
     */
    shuttleEnabled?: boolean;
    /**
     * `shuttle.kind` — `oneshot` (default) or `standing`. Standing roles have
     * a richer lifecycle (cron schedule + per-run review state). Drives column
     * placement and transition semantics: a standing role's review acceptance
     * is `shuttle-ctl accept`, not the oneshot resume+reopen dance.
     */
    shuttleKind?: 'oneshot' | 'standing';
    /**
     * `shuttle.review.state` for standing roles — `scheduled` | `awaiting` | `accepted`.
     * `awaiting` after a worker completes a run; the kanban routes the card to
     * the awaitingReview column even though `status` remains `active`. Cleared
     * (back to `scheduled`) by `shuttle-ctl accept`.
     */
    shuttleReviewState?: 'scheduled' | 'awaiting' | 'accepted';
    /**
     * `shuttle.session.id` — the session UUID of the most recently dispatched
     * worker. Written by the Shuttle daemon after a successful worker spawn via
     * `shuttle-ctl session-set`. Used to enable the "Resume previous" button on
     * awaiting-review Kanban cards. Absent when no session has been stored yet,
     * or after `shuttle-ctl session-clear`.
     */
    shuttleSessionId?: string;
    /**
     * `shuttle.agent` — the agent identifier to dispatch with (e.g. `claude-opus`).
     * Present only when `hasShuttleBlock` is true. Absent when the shuttle block
     * doesn't specify an agent (daemon uses its default).
     */
    shuttleAgent?: string;
    /**
     * `shuttle.schedule` — cron expression + IANA timezone for standing roles.
     * Present only when `hasShuttleBlock` is true and `kind === 'standing'`.
     * Read by the kanban fiber-detail modal so the human can tune the cadence
     * without dropping into vellum.
     */
    shuttleSchedule?: {
        expr: string;
        tz: string;
    };
    parentId?: string | null;
    isRoot?: boolean;
}
/**
 * Map one entry from felt's JSON output onto the Portolan Fiber interface.
 * Tool-owned namespaces (`shuttle:`, `tempered:`, `depends_on:`) arrive as
 * native JSON values (felt v1.0.4+) so we read them directly rather than
 * re-parsing YAML.
 *
 * `kind` and `priority` are not part of felt's serialized model — they're
 * Portolan/ASTRA conventions felt does not interpret. We default them so
 * downstream consumers see a uniform shape regardless of source.
 */
export declare function mapFeltJsonToFiber(item: unknown): Fiber | null;
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
 * Read one fiber through `felt show -j` and map it onto the Portolan Fiber
 * interface. Used when a caller needs a single authoritative post-write read
 * without reparsing raw markdown on the Node side.
 */
export declare function getFiber(cityPath: string, fiberId: string): Promise<Fiber | null>;
/**
 * Gets all fibers for a city regardless of status. `withBody` is off by
 * default — pass `{ withBody: true }` only when the caller actually scores
 * or renders against fiber bodies (search, tapestry). Most consumers
 * (kanban, count probes, fiber list) only need metadata.
 */
export declare function getAllFibers(cityPath: string, opts?: {
    withBody?: boolean;
}): Promise<Fiber[]>;
//# sourceMappingURL=FiberReader.d.ts.map