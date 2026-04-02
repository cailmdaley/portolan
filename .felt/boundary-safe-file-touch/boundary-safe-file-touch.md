---
title: Boundary-safe file-touch session matching
status: closed
tags:
    - portolan
depends-on:
    - coastline-file-touch-hover
created-at: 2026-03-02T04:12:59.527608+01:00
closed-at: 2026-03-02T04:13:03.711277+01:00
outcome: Updated HttpApi hook session resolution to use boundary-safe path containment (not raw startsWith) for cwd/file matching, preventing /project vs /project-alpha collisions. Added two regression tests in HttpApi.file-touch.test.ts covering cwd and file-path prefix collisions. Verified with server test suite (248 passing).
---

(boundary-safe-file-touch)=
Harden /hook/file-touch session resolution so path prefix collisions do not misattribute touches when multiple workers have similarly prefixed cwd roots.
