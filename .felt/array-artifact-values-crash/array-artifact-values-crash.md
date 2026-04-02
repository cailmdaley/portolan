---
title: Array artifact values crash TapestryView detail panel
tags:
    - portolan
    - bug
created-at: 2026-02-15T03:27:25.655839+01:00
outcome: 'evidence.json artifacts can contain arrays (e.g. individual_evidence: [...paths...]). TapestryView.artifactUrl calls .split(''/'') on each value — TypeError on arrays crashes renderDetailPanel silently, so the panel never appears. Fixed: imageArtifacts() helper filters to string-only entries. Applied to all 5 artifact access points (detail render, nav click, arrow keys, lightbox). Also fixed Evidence type from Record<string,string> to Record<string, string|string[]>.'
---

(array-artifact-values-crash)=
# Array artifact values crash TapestryView detail panel
