---
title: 'Comma-separated tags silently break tapestry: tag matching'
tags:
    - portolan
    - bug
depends-on:
    - array-artifact-values-crash
created-at: 2026-02-15T03:27:17.516839+01:00
outcome: 'felt tag and felt add -t accept ''claim, tapestry:foo'' as a single tag string. FiberReader.parseFiber reads YAML list items verbatim. The tapestry: prefix filter (startsWith) misses tags buried in comma-joined strings. Fixed in both felt (split on comma in tag/untag/add commands) and portolan (normalize in FiberReader.parseFiber and HttpApi.getAllCityFibers). 9 of 12 cmbx tapestry nodes were invisible due to this.'
---

(comma-separated-tags-silently)=
# Comma-separated tags silently break tapestry: tag matching
