---
title: 'Constitution: Portolan performance, memory, and architecture hardening'
status: closed
tags:
    - spec
created-at: 2026-03-01T13:51:04.153516+01:00
closed-at: 2026-03-01T17:47:32.793631+01:00
outcome: 'Constitution completed. All downstream hardening fibers are closed (lifecycle ownership, async race guards, bounded caches, raw binary media transport, HUD/update coalescing, remote session churn cleanup, static runtime/HMR hygiene, and runtime diagnostics). Verification evidence this iteration: npm run build passed in repo root; cd server && npm test && npm run build passed (259 tests). Audit probes were rerun for listener/timer surfaces, server map ownership/deletes, binary/raw transport usage, and cache footprints to confirm explicit teardown and bounded ownership patterns across target modules. Remaining validation is runtime stress execution in normal usage loops (file modal cycles, tapestry cycles, sustained activity, remote churn), with diagnostics now in place to observe steady-state behavior.'
---

# Constitution: Portolan Performance, Memory, and Architecture Hardening

## Desired State

Portolan is stable in long-running browser and server sessions, including Safari, without memory-pressure reloads or progressive slowdown.

The system satisfies these invariants:

- Lifecycle ownership is explicit for every long-lived resource.
  - Event listeners, timers, animation frames, observers, WebSocket handlers, and render resources have deterministic teardown paths.
  - Repeated open/close/navigate cycles do not increase global listener counts or retained DOM nodes.
- Async flows are race-safe.
  - In-flight requests and renders are cancelable or guarded so stale completions cannot mutate current UI state.
- Caches are bounded and intentional.
  - Every cache has a size/age policy and an owner responsible for eviction and cleanup.
- Binary media transport is memory-efficient.
  - Large images/PDFs are delivered via raw/streamed paths rather than JSON base64 payloads.
- State updates are coalesced.
  - High-frequency activity/events do not trigger full UI rebuilds when only localized changes are needed.
- Session lifecycle is coherent on the server.
  - Session creation/removal updates all related maps consistently; no stale per-session data remains after worker churn.
  - Per-session activity ownership is keyed by globally unique identity (`originId:tmuxSession`) to prevent cross-origin collisions.
- Dev and production lifecycle behavior are aligned.
  - HMR/dev loops do not hide leaks or create leak-only artifacts that mask production diagnostics.
- Performance and memory are observable.
  - There are durable diagnostics and repeatable stress checks for memory growth, listener growth, and update throughput.

Quality bar:

- User-visible interactions remain responsive under sustained activity.
- Memory usage reaches steady state under repeated workflows instead of monotonic growth.
- Resource cleanup behavior is verifiable by code inspection and runtime probes.

## Scope

- Includes frontend runtime (`src/main.ts`, UI modules, render modules), backend runtime (`server/src`), and client/server transport for file and activity flows.
- Includes architectural refactors needed to establish clear ownership of state, resources, and update propagation.
- Includes static export mode and HMR lifecycle hygiene where it affects leak diagnosis.
- Excludes unrelated product semantics, visual redesign, and feature expansion not required for performance/memory correctness.

## Context

Primary surfaces and ownership boundaries:

- Frontend bootstrap and global event loop:
  - `src/main.ts`
- UI components with document-level handlers and modal/detail lifecycle:
  - `src/ui/FileViewerModal.ts`
  - `src/ui/TapestryView.ts`
  - `src/ui/CityHUD.ts`
  - `src/ui/PlaygroundViewer.ts`
  - `src/ui/ConversationCard.ts`
- Shared UI cache/asset utilities:
  - `src/ui/utils.ts`
- Render/update paths and high-frequency worker activity visuals:
  - `src/render/ZoneRenderer.ts`
- Server session and remote-origin lifecycle:
  - `server/src/index.ts`
  - `server/src/SessionTracker.ts`
  - `server/src/EventWatcher.ts`
  - `server/src/ConversationCache.ts`
  - `server/src/TranscriptReader.ts`
- File/media HTTP transport:
  - `server/src/HttpApi.ts`

Architectural direction:

- Favor explicit ownership modules for lifecycle and cleanup rather than ad hoc local cleanup.
- Favor local, incremental updates over broad re-render paths for high-frequency events.
- Favor transport and cache strategies that minimize copied payloads and duplicate in-memory representations.

## Skills

- `/implementing-code`
- `/felt`
- `/confer` for design review on architectural pivots with broad blast radius

## Evidence

Use these checks as durable pointers while iterating:

- Build and test integrity:
  - `npm run build`
  - `cd server && npm test && npm run build`
- Lifecycle coverage audit:
  - `rg -n "document\\.addEventListener|window\\.addEventListener|setInterval\\(|requestAnimationFrame\\(" src`
  - `rg -n "dispose\\(|hide\\(" src/ui src/render src/main.ts`
- Server map ownership and cleanup audit:
  - `rg -n "new Map<|const .* = new Map" server/src`
  - `rg -n "delete\\(" server/src/index.ts server/src/*.ts`
- Binary transport and large-payload audit:
  - `rg -n "binary=true|raw=true|data:" src server/src`
- Cache policy audit:
  - `rg -n "Cache|new Map\\(" src/ui server/src`

Runtime stress evidence should include:

- Repeated file modal open/navigate/close loops (text + image + PDF).
- Repeated tapestry open/detail/close loops, including static modal and artifact gallery paths.
- Sustained activity stream with active worker cards and HUD visible.
- Remote worker/session churn without full origin disconnect.

Completion evidence:

- No unpaired lifecycle hooks in audited surfaces.
- No stale per-session server map entries after churn scenarios.
- Memory and listener counts plateau under repeated stress loops.
- Interaction latency remains stable during sustained event ingress.

## Open Questions

- Should architectural work prioritize one unifying lifecycle abstraction immediately, or accept staged convergence while retaining behavior compatibility?

## Comments
**2026-03-01 13:52** — Drafted constitution with desired-state invariants for lifecycle ownership, async cancellation/race safety, bounded caches, raw binary media transport, server session map coherence, event coalescing, and durable evidence probes/stress scenarios.
**2026-03-01 13:55** — Removed Chrome-specific testing assumption from Open Questions per user preference; constitution remains browser-agnostic for implementation and user-driven manual validation.
