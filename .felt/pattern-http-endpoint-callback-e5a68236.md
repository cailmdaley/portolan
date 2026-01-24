---
title: 'Pattern: HTTP endpoint callback for cross-module coordination'
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T00:44:45.924985+01:00
closed-at: 2026-01-24T00:44:45.924986+01:00
close-reason: |-
    When an HTTP endpoint needs functionality from another module (like creating workers from send-annotations endpoint), use a setter callback pattern:

    1. Define callback type and storage in HttpApi:
       `private onCreateNewWorker: ((cityPath: string, originId: string) => Promise<string>) | null = null;`

    2. Add setter method:
       `setOnCreateNewWorker(fn: ...): void { this.onCreateNewWorker = fn; }`

    3. Wire up in index.ts after module initialization:
       `httpApi.setOnCreateNewWorker(async (cityPath, originId) => { ... })`

    This avoids circular dependencies and keeps modules decoupled while allowing cross-cutting functionality.
---
