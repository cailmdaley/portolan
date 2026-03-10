---
title: Fix lightbox click after carousel nav
status: closed
tags:
    - portolan
depends-on:
    - pdf-artifact-support-in-tapestry-7049938c
created-at: 2026-02-25T16:35:11.030725+01:00
outcome: Switched artifact lightbox trigger from per-element listeners to delegated click handling on the detail panel so carousel re-renders (from arrow-key navigation) no longer drop click behavior. Applies to images and PDFs, including PDF overlay button. Verified with frontend build.
---
