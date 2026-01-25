---
title: Simplify hexarchy-v2 codebase
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T16:51:47.896509+01:00
closed-at: 2026-01-24T19:03:49.877243+01:00
close-reason: 'Phase 1 complete: removed PALETTE_CSS, getOriginIdForSocket, getAllStatuses, getAllFiles/getRemoteFiles, findLocalSession, buildState debug logs. Phase 2 partial: extracted parseSearchResults utility; SSH patterns in HttpApi differ enough that extraction isn''t valuable. Phase 3 assessed: mock data timeout is intentional dev fallback; lookup interfaces vary by module. 99 tests pass, builds succeed.'
---

# Spec

You are in a Ralph loop — autonomous iteration toward completion.

## Rhythm

1. **Survey** — What's done? What's incomplete? Fresh judgment.
2. **Work** — Pick highest-value task. Delegate routine work if useful (2-3 agents max, different files).
3. **Exit** — `kill $PPID` is always the last thing you do. It continues the loop.

**Close parent fiber only when:** you surveyed everything, ran tests, tried it, found nothing to contribute, and made zero changes this iteration. Then `felt off <id> -r "..."` followed by `kill $PPID`.

---

## Goal

Remove dead code, unify duplicate patterns, and reduce unnecessary abstraction in hexarchy-v2.

## Design

### Phase 1: Dead Code Removal
Delete unused exports, methods, and variables identified in analysis:
- `PALETTE_CSS` in types.ts
- `getOriginIdForSocket()` in OriginManager.ts
- `getAllStatuses()` in GitStatusManager.ts
- `getAllFiles()`, `getRemoteFiles()` in RecentFilesManager.ts
- `findLocalSession()` in sessionLookup adapter
- Debug console.logs in index.ts

### Phase 2: Duplicate Patterns
- Extract `sshFileRead()` utility from repeated SSH patterns in HttpApi.ts
- Extract `parseSearchResults()` from searchLocal/searchRemote in index.ts
- Leave agent.js extractSummary copy as-is (agent runs standalone, can't import)

### Phase 3: Cleanup
- Remove mock data timeout in main.ts if no longer needed
- Unify lookup interfaces if practical (CityLookup, SessionLookup, OriginLookup)

## Context

Server modules:
- server/src/index.ts — main wiring, buildState, WebSocket
- server/src/HttpApi.ts — HTTP endpoints, SSH file operations
- server/src/OriginManager.ts — remote agent tracking
- server/src/GitStatusManager.ts — git status polling
- server/src/RecentFilesManager.ts — recent files tracking
- server/src/KittyIntegration.ts — terminal focus

Frontend:
- src/state/types.ts — shared types
- src/main.ts — Three.js setup, event handling

Tests: server/src/index.test.ts

## Completion

1. `npm run build` succeeds in both root and server/
2. `npm test` passes in server/
3. No unused exports flagged by searching for definitions without imports
4. SSH file reading consolidated into fewer code paths
5. Search result parsing extracted and shared
