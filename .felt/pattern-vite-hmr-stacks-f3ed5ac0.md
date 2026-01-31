---
title: 'Pattern: Vite HMR stacks constructor event listeners'
status: closed
kind: spec
priority: 2
created-at: 2026-01-30T17:25:56.144105+01:00
closed-at: 2026-01-30T17:25:56.144108+01:00
close-reason: |-
    When Vite hot-reloads a module, constructors re-run. If a class adds a document-level event listener in its constructor, each HMR cycle adds another listener without removing the old one.

    **Symptom:** Behavior that worked initially breaks after code changes/rebuilds.

    **Example:** ContextMenu added `document.addEventListener('click', () => this.hide())` in constructor. After HMR, multiple listeners existed — old ones without guards, new one with.

    **Solutions:**
    1. Add listeners dynamically in show(), remove in hide()
    2. Store handler reference for proper removeEventListener
    3. Suppress events at source rather than in components

    ```typescript
    // Dynamic listener pattern
    private closeHandler: ((e: MouseEvent) => void) | null = null

    show() {
      this.removeCloseHandler()
      this.closeHandler = (e) => { /* ... */ }
      document.addEventListener('click', this.closeHandler)
    }

    hide() {
      this.removeCloseHandler()
    }
    ```
---
