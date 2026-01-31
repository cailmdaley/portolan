---
title: 'Hexarchy Persistence: annotations, cities, activity'
status: closed
kind: spec
priority: 2
depends-on:
    - hexarchy-overview-spatial-map-40356835
created-at: 2026-01-30T17:41:47.790969+01:00
closed-at: 2026-01-30T17:41:47.790971+01:00
close-reason: |-
    ## What Persists

    | Data | Storage | Survives |
    |------|---------|----------|
    | **Annotations** | `~/.hexarchy/annotations.json` | Server restart |
    | **Cities** | `~/.hexarchy/cities.json` | Server restart, session end |
    | **Worker activity** | In-memory per session | Session only |

    ## Annotations

    Per-file feedback sent to workers. Stored by originId (city identifier).

    ```typescript
    interface PersistedAnnotation {
      filePath: string
      lineNumber: number
      text: string
      timestamp: number
      originId: string  // city identifier
    }
    ```

    **AnnotationPersistence.ts** handles load/save. Annotations filter by originId so each city sees only its own.

    ## Cities

    Cities persist beyond their sessions. A city with no active workers becomes 'dormant' (gray). Clicking a dormant remote city can trigger SSH + agent start.

    ```typescript
    interface PersistedCity {
      id: string
      name: string
      path: string
      hex: { q: number, r: number }
      isRemote: boolean
      sshHost?: string
    }
    ```

    ## Key Files
    - `server/src/AnnotationPersistence.ts`
    - `server/src/CityManager.ts` — city persistence logic
    - `~/.hexarchy/` — persistence directory
---
