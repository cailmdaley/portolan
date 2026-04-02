---
title: Extraction pattern
tags:
    - doc
    - '[portolan]'
depends-on:
    - simplification-sweep
created-at: 2026-03-11T22:46:12.097671+01:00
outcome: |-
    The simplification sweep established a consistent decomposition pattern across the portolan codebase:

    **Coordinator + Runtime + Interactions + Domain Modules**

    A coordinator (e.g. TapestryView, CityHUD, HttpApi, KittyIntegration) is a thin wiring layer that:
    - Owns the container/lifecycle
    - Delegates data/state to a Runtime module (e.g. TapestryViewRuntime)
    - Delegates input handling to an Interactions module (e.g. TapestryViewInteractions)
    - Delegates domain subsystems to focused modules (e.g. TapestryDagVisibility, CityHUDSearch)

    Each extracted module has:
    - A single, describable responsibility (no conjunctions needed)
    - Explicit dependencies via constructor injection
    - No hidden state in parent coordinators
    - Independent testability

    **Naming conventions:**
    - `FooRuntime` — data/state management extracted from Foo
    - `FooInteractions` — input/event handling extracted from Foo
    - `FooBar` — domain subsystem Bar extracted from Foo (e.g. CityHUDSearch, TapestryDagVisibility)

    **When to extract:** When a file has section headers (`// === X ===`), those sections are the seams. When you can describe a file's job only with conjunctions ('and'), it owns multiple concerns. A well-organized large file is not the same as a clean file.

    **Metrics from the sweep:**
    - 8 monolithic files (2k-3.2k LOC) → ~55 focused modules
    - Net LOC: -1,594 (24,746 → 23,152)
    - Files: 42 → 97
    - Largest file: 541 LOC (HttpApiFileContent — cohesive file I/O)
    - All 252 tests pass throughout
---

(extraction-pattern)=
# Extraction pattern
