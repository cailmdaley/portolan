---
title: 'Pattern: HttpApi setter injection for late dependencies'
status: closed
kind: spec
priority: 2
created-at: 2026-01-23T23:39:29.331699+01:00
closed-at: 2026-01-23T23:39:29.331701+01:00
close-reason: |-
    When a class (like HttpApi) is constructed early but needs dependencies that are defined later, use setter methods instead of constructor parameters:

    ```typescript
    // In HttpApi
    private annotationPersistence: AnnotationPersistence | null = null;

    setAnnotationPersistence(persistence: AnnotationPersistence): void {
      this.annotationPersistence = persistence;
    }
    ```

    Then after construction:
    ```typescript
    const httpApi = new HttpApi(cityManager, originManager, cityPersistence);
    httpApi.setAnnotationPersistence(annotationPersistence);
    httpApi.setSessionLookup(sessionLookup);
    ```

    This avoids circular dependency issues and keeps initialization order flexible. Handlers must null-check before using the dependency.
---
