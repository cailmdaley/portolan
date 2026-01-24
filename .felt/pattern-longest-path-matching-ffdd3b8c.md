---
title: 'Pattern: Longest-path matching for hierarchical path lookups'
status: closed
kind: spec
priority: 2
depends-on:
    - file-annotations-in-e8dbee22
created-at: 2026-01-24T00:38:10.317034+01:00
closed-at: 2026-01-24T00:38:10.317035+01:00
close-reason: |-
    When looking up entities by path prefix (e.g., finding which city owns a file path), simple `startsWith() + find()` returns the FIRST match, not the BEST match.

    **Problem:** `/Users/cd280747/Documents/projects/hexarchy-v2/src/foo.ts` matches both:
    - `/Users/cd280747` (cd280747 city)
    - `/Users/cd280747/Documents/projects/hexarchy-v2` (hexarchy-v2 city)

    `find()` returns first match, which may be wrong.

    **Solution:** Filter all matches, then reduce to find longest path:
    ```typescript
    const matchingCities = cities.filter(c => path.startsWith(c.path))
    const city = matchingCities.reduce<City | null>((best, c) => {
      if (!best || c.path.length > best.path.length) return c
      return best
    }, null)
    ```

    **Applies to:** Any lookup where paths can be hierarchically nested (home dir contains projects, projects contain subprojects, etc.)

    File: src/main.ts:85
---
