---
title: Fix staticDataBase URL
status: closed
tags:
    - gotcha
depends-on:
    - file-link-export
created-at: 2026-03-15T11:02:16.139902+01:00
outcome: Regex /\/[^\/]+\/tapestry$/ stripped project name from assetBase. /tapestries/data/pure_eb/tapestry became /tapestries/data. Fixed to /\/tapestry$/. All static file URLs were resolving to wrong base.
---

(fix-staticdatabase-url)=
# Fix staticDataBase URL
